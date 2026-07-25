import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Archive, CheckCheck, Inbox, Mail, MailOpen } from 'lucide-react';
import { api, type InboxItem } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const STATES = ['unread', 'read', 'all', 'archived'] as const;

const SEV_VARIANT: Record<string, 'outline' | 'secondary' | 'destructive'> = {
  info: 'outline', success: 'secondary', warning: 'secondary',
  error: 'destructive', critical: 'destructive', security: 'destructive',
};

/**
 * The personal in-app inbox.
 *
 * Every item here belongs to exactly one account — this user's. It replaces a
 * broadcast log in which no notification had an owner at all.
 *
 * A notification's stored title may be an i18n key when the producing event carried
 * no human title, so titles are resolved through `t()` with the raw value as the
 * fallback. That keeps a key from leaking into the UI without inventing text for it.
 */
export function NotificationInboxPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [state, setState] = useState<string>('unread');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const inbox = useQuery({
    queryKey: ['account', 'notifications', 'inbox', state, search, page],
    queryFn: () => api.account.notifications.inbox({
      state, search, page: String(page), pageSize: '25',
    }),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'inbox'] });
    void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'unread'] });
  };

  const markRead = useMutation({
    mutationFn: (v: { id: string; read: boolean }) => api.account.notifications.markRead(v.id, v.read),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.account.notifications.archiveNotification(id),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => api.account.notifications.markAllRead(),
    onSuccess: (r) => { invalidate(); toast.success(t('inbox.allRead', { count: r.updated })); },
  });
  const archiveRead = useMutation({
    mutationFn: () => api.account.notifications.archiveRead(),
    onSuccess: (r) => { invalidate(); toast.success(t('inbox.archivedRead', { count: r.archived })); },
  });

  /** Titles may be i18n keys; resolve, falling back to the stored text. */
  const titleOf = (n: InboxItem) => t(n.title as never, { defaultValue: n.title });

  function open(n: InboxItem) {
    if (!n.read) markRead.mutate({ id: n.id, read: true });
    // The link is re-authorized by the destination route; it is a pointer, never a
    // capability granted by having received the notification.
    if (n.deepLink) navigate(n.deepLink);
  }

  if (inbox.isLoading) return <CenteredSpinner />;
  if (inbox.isError) return <ErrorState title={t('inbox.loadError')} onRetry={() => void inbox.refetch()} />;

  const data = inbox.data!;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Inbox className="h-5 w-5" /> {t('inbox.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('inbox.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => markAll.mutate()}>
            <CheckCheck className="h-3.5 w-3.5" /> {t('inbox.markAllRead')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => archiveRead.mutate()}>
            <Archive className="h-3.5 w-3.5" /> {t('inbox.archiveRead')}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="ib-state">{t('inbox.state')}</Label>
            <Select
              id="ib-state" value={state}
              onChange={(e) => { setState(e.target.value); setPage(1); }}
              options={STATES.map((s) => ({ value: s, label: t(`inbox.states.${s}`) }))}
            />
          </div>
          <div className="min-w-[12rem] flex-1 space-y-1.5">
            <Label htmlFor="ib-search">{t('inbox.search')}</Label>
            <Input
              id="ib-search" value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder={t('inbox.searchPlaceholder')}
            />
          </div>
          <span className="text-xs text-muted-foreground">{t('inbox.total', { count: data.total })}</span>
        </CardContent>
      </Card>

      {data.items.length === 0 ? (
        <EmptyState title={t('inbox.empty')} />
      ) : (
        <div className="space-y-2">
          {data.items.map((n) => (
            <Card key={n.id} className={n.read ? 'opacity-75' : undefined}>
              <CardContent className="space-y-1.5 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {!n.read && <span className="h-2 w-2 rounded-full bg-primary" aria-label={t('inbox.states.unread')} />}
                  <button type="button" className="text-left font-medium hover:underline" onClick={() => open(n)}>
                    {titleOf(n)}
                  </button>
                  {n.groupCount > 1 && <Badge variant="outline">×{n.groupCount}</Badge>}
                  <Badge variant={SEV_VARIANT[n.severity] ?? 'outline'}>
                    {t(`matrix.severity.${n.severity}`)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t(`matrix.category.${n.category}`, { defaultValue: n.category })}
                  </span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(n.lastAt).toLocaleString()}
                  </span>
                </div>

                {n.body && <p className="text-sm text-muted-foreground">{n.body}</p>}

                {n.deliveries.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {n.deliveries.map((d, i) => (
                      <Badge key={i} variant="outline" className="text-[10px]">
                        {t(`matrix.channel.${d.channelType}` as never, { defaultValue: d.channelType })}: {t(`inbox.delivery.${d.status}` as never, { defaultValue: d.status })}
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-1.5 border-t border-white/5 pt-1.5">
                  <Button variant="ghost" size="sm" onClick={() => markRead.mutate({ id: n.id, read: !n.read })}>
                    {n.read ? <><Mail className="h-3.5 w-3.5" /> {t('inbox.markUnread')}</>
                            : <><MailOpen className="h-3.5 w-3.5" /> {t('inbox.markRead')}</>}
                  </Button>
                  {!n.archived && (
                    <Button variant="ghost" size="sm" onClick={() => archive.mutate(n.id)}>
                      <Archive className="h-3.5 w-3.5" /> {t('inbox.archive')}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('inbox.prev')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('inbox.page', { page, pages })}</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            {t('inbox.next')}
          </Button>
        </div>
      )}
    </div>
  );
}
