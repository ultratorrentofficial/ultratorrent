import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { api, type InboxItem } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { RichNotificationCard } from '@/components/notifications/presentation/RichNotificationCard';

/** How many recent notifications the panel shows before deferring to the inbox. */
const PANEL_SIZE = 8;

/**
 * Top-bar unread indicator and recent-notification panel for the signed-in user.
 *
 * The count and the list come from the user's OWN inbox only — the server derives
 * the owner from the JWT, so there is no request shape that could read someone
 * else's.
 *
 * Live updates arrive on the personal socket room, which the gateway joins from
 * the token's subject on connect. Nothing here subscribes by user id, because a
 * client-supplied id is exactly how a room becomes hijackable. Polling backs the
 * socket up so a dropped connection degrades to "slightly stale" rather than
 * "silently wrong".
 */
export function NotificationBell({ className }: { className?: string }) {
  const { t } = useTranslation('notificationCenter');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const unread = useQuery({
    queryKey: ['account', 'notifications', 'unread'],
    queryFn: () => api.account.notifications.unreadCount(),
    refetchInterval: 60_000,
    // A failure here must never surface as a broken shell — the bell simply
    // shows nothing.
    retry: false,
  });

  // Fetched only while the panel is open. The badge already tells the user
  // whether anything is waiting, so polling a list nobody is looking at buys
  // nothing and costs a request a minute for every signed-in session.
  const recent = useQuery({
    queryKey: ['account', 'notifications', 'inbox', 'panel'],
    queryFn: () => api.account.notifications.inbox({ pageSize: String(PANEL_SIZE), state: 'all' }),
    enabled: open,
    retry: false,
  });

  const markAllRead = useMutation({
    mutationFn: () => api.account.notifications.markAllRead(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'unread'] });
      void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'inbox'] });
    },
  });

  useEffect(() => {
    // `on()` returns its own unsubscribe, and handlers are re-bound across
    // reconnects by the client, so a dropped socket does not silently stop
    // updating the badge.
    const off = wsClient.on('account.notification.created' as never, () => {
      void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'unread'] });
      void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'inbox'] });
    });
    return off;
  }, [qc]);

  // Escape closes, and scrolling closes rather than leaving the panel detached
  // from the button it is anchored to — the same dismissal contract the context
  // menu uses, so the shell behaves consistently.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onScroll = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const count = unread.data?.unread ?? 0;
  const label = count > 0 ? t('bell.unread', { count }) : t('bell.none');

  function openItem(n: InboxItem) {
    setOpen(false);
    if (!n.read) {
      // Fire-and-forget: navigation must not wait on a read receipt, and a failed
      // mark leaves the notification unread, which is the safe direction.
      api.account.notifications.markRead(n.id, true)
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'unread'] });
          void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'inbox'] });
        })
        .catch(() => undefined);
    }
    // `deepLink` is re-authorized by the destination route; it is a hint about
    // where to go, never a capability to go there.
    navigate(n.deepLink || '/account/notifications/inbox');
  }

  const items = recent.data?.items ?? [];

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        type="button"
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          // The number is the signal, not the colour — it is also in the aria-label.
          <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* A transparent full-screen layer is what makes "click anywhere else"
              dismiss the panel, including over content that stops propagation. */}
          <div className="fixed inset-0 z-[55]" onClick={() => setOpen(false)} aria-hidden="true" />

          <div
            ref={panelRef}
            role="dialog"
            aria-label={t('bell.panelTitle')}
            className="absolute right-0 z-[60] mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg glass shadow-card animate-scale-in"
          >
            <header className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
              <span className="text-sm font-semibold">{t('bell.panelTitle')}</span>
              <span className="flex-1" />
              {count > 0 && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => markAllRead.mutate()}
                  disabled={markAllRead.isPending}
                >
                  <CheckCheck className="h-3.5 w-3.5" /> {t('inbox.markAllRead')}
                </button>
              )}
            </header>

            <div className="max-h-[26rem] overflow-y-auto">
              {recent.isLoading ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('bell.loading')}</p>
              ) : recent.isError ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('bell.loadError')}</p>
              ) : items.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('inbox.empty')}</p>
              ) : (
                <ul className="divide-y divide-white/5">
                  {items.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => openItem(n)}
                        className={`block w-full px-3 py-2.5 text-left transition-colors hover:bg-white/5 ${n.read ? 'opacity-60' : ''}`}
                      >
                        {n.presentation ? (
                          // The compact projection: no fact table, no action button
                          // — the panel row IS the action.
                          <RichNotificationCard presentation={n.presentation} compact />
                        ) : (
                          <>
                            <p className="truncate text-sm">
                              {t(n.title as never, { defaultValue: n.title })}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {new Date(n.lastAt).toLocaleString()}
                            </p>
                          </>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <footer className="border-t border-white/5">
              <button
                type="button"
                className="w-full px-3 py-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                onClick={() => { setOpen(false); navigate('/account/notifications/inbox'); }}
              >
                {t('bell.viewAll')}
              </button>
            </footer>
          </div>
        </>
      )}
    </div>
  );
}
