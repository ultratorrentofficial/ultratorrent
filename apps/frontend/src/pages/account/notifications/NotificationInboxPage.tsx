import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Archive, CheckCheck, Inbox, Mail, MailOpen } from 'lucide-react';
import { api, type InboxNotificationDto } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { RichNotificationCard } from '@/components/playback/RichNotificationCard';

const SEVERITY_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  info: 'secondary',
  success: 'default',
  warning: 'outline',
  error: 'destructive',
};

/**
 * The personal inbox.
 *
 * Everything here is scoped to the signed-in user by the API — there is no user
 * selector because there is nothing to select. Real-time arrivals come over the
 * personal socket room, which the gateway joins from the JWT subject.
 */
export function NotificationInboxPage() {
  const { t } = useTranslation('notifications');
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [state, setState] = useState('all');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');

  const inbox = useQuery({
    queryKey: ['account', 'notifications', 'inbox', { page, state, category, search }],
    queryFn: () =>
      api.account.notifications.inbox({
        page: String(page),
        state,
        ...(category && { category }),
        ...(search.trim() && { search: search.trim() }),
      }),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'inbox'] });
    void qc.invalidateQueries({ queryKey: ['account', 'notifications', 'unread'] });
  };

  useEffect(() => {
    // Re-bound across reconnects by the client, so a dropped socket does not
    // silently stop the list updating.
    const off = wsClient.on('account.notification.created' as never, () => invalidate());
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);

  const setRead = useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) =>
      api.account.notifications.markRead(id, read),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e?.message || t('inbox.actionFailed')),
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.account.notifications.archive(id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e?.message || t('inbox.actionFailed')),
  });

  const markAll = useMutation({
    mutationFn: () => api.account.notifications.markAllRead(),
    onSuccess: () => {
      invalidate();
      toast.success(t('inbox.allRead'));
    },
  });

  function open(n: InboxNotificationDto) {
    if (!n.read) setRead.mutate({ id: n.id, read: true });
    // A hint about where to go — the destination route re-authorizes.
    if (n.deepLink) navigate(n.deepLink);
  }

  if (inbox.isLoading) return <CenteredSpinner />;
  if (inbox.isError) {
    return <ErrorState title={t('inbox.loadError')} onRetry={() => void inbox.refetch()} />;
  }

  const data = inbox.data!;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Inbox className="h-5 w-5" /> {t('inbox.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('inbox.subtitle')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
          <CheckCheck className="h-3.5 w-3.5" /> {t('inbox.markAllRead')}
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <Input
            className="sm:max-w-xs"
            placeholder={t('inbox.searchPlaceholder')}
            aria-label={t('inbox.searchPlaceholder')}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
          <Select
            className="w-40"
            aria-label={t('inbox.state')}
            value={state}
            onChange={(e) => { setState(e.target.value); setPage(1); }}
            options={[
              { value: 'all', label: t('inbox.states.all') },
              { value: 'unread', label: t('inbox.states.unread') },
              { value: 'read', label: t('inbox.states.read') },
              { value: 'archived', label: t('inbox.states.archived') },
            ]}
          />
          <Select
            className="w-44"
            aria-label={t('inbox.category')}
            value={category}
            onChange={(e) => { setCategory(e.target.value); setPage(1); }}
            options={[
              { value: '', label: t('inbox.allCategories') },
              ...['playback', 'downloads', 'storage', 'workflows', 'providers', 'security', 'users'].map(
                (c) => ({ value: c, label: t(`categories.${c}`, { defaultValue: c }) }),
              ),
            ]}
          />
        </CardContent>
      </Card>

      {data.items.length === 0 ? (
        <EmptyState title={t('inbox.empty')} description={t('inbox.emptyHint')} />
      ) : (
        <div className="space-y-2">
          {data.items.map((n) => (
            <Card key={n.id} className={n.read ? 'opacity-75' : undefined}>
              <CardContent className="space-y-1.5 p-3">
                {/* The rich card already states who did what to which title, so
                    the plain title line below is suppressed when one renders.
                    The metadata row stays either way: severity, category and
                    read state are inbox concerns the card knows nothing of. */}
                {n.presentation && (
                  <button
                    type="button"
                    onClick={() => open(n)}
                    className="block w-full text-left"
                    aria-label={n.presentation.summary.text}
                  >
                    <RichNotificationCard presentation={n.presentation} />
                  </button>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {!n.read && (
                    <span
                      className="h-2 w-2 rounded-full bg-primary"
                      aria-label={t('inbox.states.unread')}
                    />
                  )}
                  {!n.presentation && (
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      onClick={() => open(n)}
                    >
                      {n.title}
                    </button>
                  )}
                  <Badge variant={SEVERITY_VARIANT[n.severity] ?? 'outline'}>
                    {t(`severities.${n.severity}`, { defaultValue: n.severity })}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t(`categories.${n.category}`, { defaultValue: n.category })}
                  </span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>

                {n.body && !n.presentation && <p className="text-sm text-muted-foreground">{n.body}</p>}

                <div className="flex flex-wrap gap-1.5 border-t border-white/5 pt-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRead.mutate({ id: n.id, read: !n.read })}
                  >
                    {n.read ? (
                      <><Mail className="h-3.5 w-3.5" /> {t('inbox.markUnread')}</>
                    ) : (
                      <><MailOpen className="h-3.5 w-3.5" /> {t('inbox.markRead')}</>
                    )}
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

      <Pagination
        page={data.page}
        pageSize={data.pageSize}
        total={data.total}
        onPage={setPage}
      />
    </div>
  );
}
