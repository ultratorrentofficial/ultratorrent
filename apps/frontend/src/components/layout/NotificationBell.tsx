import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';

/**
 * Top-bar unread indicator for the signed-in user's inbox.
 *
 * The count is the user's own: the server derives the owner from the JWT, so
 * there is no request shape that could count someone else's. Live updates arrive
 * on the personal socket room, which the gateway joins from the token subject on
 * connect — nothing here subscribes by user id, because a client-supplied id is
 * exactly how a room becomes hijackable.
 */
export function NotificationBell({ className }: { className?: string }) {
  const { t } = useTranslation('notifications');
  const navigate = useNavigate();
  const qc = useQueryClient();

  const unread = useQuery({
    queryKey: ['account', 'notifications', 'unread'],
    queryFn: () => api.account.notifications.unreadCount(),
    // Polling backs the socket up, so a dropped connection degrades to
    // "slightly stale" rather than "silently wrong".
    refetchInterval: 60_000,
    // A failure here must never surface as a broken shell.
    retry: false,
  });

  useEffect(() => {
    const off = wsClient.on('account.notification.created' as never, () => {
      void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'unread'] });
      void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'inbox'] });
    });
    return off;
  }, [qc]);

  const count = unread.data?.unread ?? 0;
  const label = count > 0 ? t('bell.unread', { count }) : t('bell.none');

  return (
    <button
      type="button"
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground ${className ?? ''}`}
      onClick={() => navigate('/account/notifications/inbox')}
      aria-label={label}
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
  );
}
