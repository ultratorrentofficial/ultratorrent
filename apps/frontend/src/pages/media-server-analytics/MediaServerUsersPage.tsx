import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Users } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api, ApiError, type MediaServerUserMeta } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

/**
 * Media Server → Users. Every account synced from every connected server, with a
 * friendly name and an address an admin can set.
 *
 * The friendly name is stored HERE and never written back to the media server,
 * and that is a property of the servers rather than a shortcut:
 *   - Plex reports a `title`, which for an account whose owner never chose a
 *     display name is just the login handle. A shared user's name belongs to
 *     their own plex.tv profile — there is no owner-facing API to change it, and
 *     changing it would rename them on every server they use.
 *   - Jellyfin and Emby expose a login `Name` and no friendly-name concept at
 *     all, so an override here is the only way to get a readable name.
 *   - Kodi has no user accounts.
 * Which is also how Tautulli has always done it: a local `friendly_name` column
 * layered over the server's own values, never pushed back.
 */

/** Empty means "use the synced name" — the field is an override, not a rename. */
function effectiveName(u: MediaServerUserMeta): string {
  return u.displayName || u.userName;
}

export function MediaServerUsersPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canManage = hasPermission(PERMISSIONS.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS);
  const users = useQuery({ queryKey: ['msa', 'meta-users'], queryFn: () => api.mediaServerAnalytics.metaUsers() });
  const dash = useQuery({ queryKey: ['msa', 'dashboard'], queryFn: () => api.mediaServerAnalytics.dashboard() });

  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftEmail, setDraftEmail] = useState('');

  /** connectionId → the server it belongs to, so a multi-server install stays legible. */
  const servers = useMemo(() => {
    const m = new Map<string, { name: string; kind: string }>();
    for (const c of dash.data?.connections ?? []) m.set(c.id, { name: c.name, kind: c.kind });
    return m;
  }, [dash.data]);

  const save = useMutation({
    mutationFn: (v: { id: string; displayName: string; email: string }) =>
      api.mediaServerAnalytics.updateMetaUser(v.id, { displayName: v.displayName, email: v.email }),
    onSuccess: () => {
      setEditing(null);
      toast.success(t('users.saved'));
      queryClient.invalidateQueries({ queryKey: ['msa', 'meta-users'] });
      // The newsletter picker reads the same rows.
      queryClient.invalidateQueries({ queryKey: ['msa', 'newsletter-recipients'] });
    },
    onError: (e) => toast.error(t('users.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const rows = useMemo(() => {
    const all = users.data ?? [];
    const q = filter.trim().toLowerCase();
    const matched = q
      ? all.filter((u) =>
          [u.userName, u.displayName ?? '', u.email ?? ''].some((f) => f.toLowerCase().includes(q)),
        )
      : all;
    return [...matched].sort((a, b) => effectiveName(a).localeCompare(effectiveName(b)));
  }, [users.data, filter]);

  const named = (users.data ?? []).filter((u) => u.displayName).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Users className="mt-1 h-6 w-6 text-muted-foreground" aria-hidden />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('users.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('users.subtitle')}</p>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                className="pl-8"
                placeholder={t('users.searchPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {t('users.count', { shown: rows.length, total: users.data?.length ?? 0, named })}
            </span>
          </div>

          {users.isLoading ? (
            <CenteredSpinner label={t('users.loading')} />
          ) : users.isError ? (
            <ErrorState message={t('users.error')} onRetry={() => users.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState title={t('users.emptyTitle')} description={t('users.emptyDescription')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t('users.colName')}</th>
                    <th className="py-2 pr-3 font-medium">{t('users.colAccount')}</th>
                    <th className="py-2 pr-3 font-medium">{t('users.colServer')}</th>
                    <th className="py-2 pr-3 font-medium">{t('users.colEmail')}</th>
                    <th className="py-2 pr-3 text-right font-medium tabular-nums">{t('users.colPlays')}</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => {
                    const server = u.connectionId ? servers.get(u.connectionId) : undefined;
                    const isEditing = editing === u.id;
                    return (
                      <tr key={u.id} className="border-b border-border/30 last:border-0 hover:bg-white/5">
                        <td className="py-2 pr-3 align-top">
                          {isEditing ? (
                            <div className="space-y-1">
                              <Label className="text-[11px]" htmlFor={`n-${u.id}`}>{t('users.colName')}</Label>
                              <Input
                                id={`n-${u.id}`}
                                className="h-8 w-52"
                                autoFocus
                                placeholder={u.userName}
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                              />
                            </div>
                          ) : (
                            <span className="font-medium">{effectiveName(u)}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 align-top font-mono text-xs text-muted-foreground">
                          {u.userName}
                        </td>
                        <td className="py-2 pr-3 align-top">
                          {server ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Badge variant="secondary">{server.kind}</Badge>
                              <span className="text-xs text-muted-foreground">{server.name}</span>
                            </span>
                          ) : (
                            /* A user whose connection is gone — imported history, or a
                               server that was removed. Still a valid recipient. */
                            <span className="text-xs italic text-muted-foreground/70">{t('users.noServer')}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 align-top">
                          {isEditing ? (
                            <div className="space-y-1">
                              <Label className="text-[11px]" htmlFor={`e-${u.id}`}>{t('users.colEmail')}</Label>
                              <Input
                                id={`e-${u.id}`}
                                className="h-8 w-56"
                                type="email"
                                value={draftEmail}
                                onChange={(e) => setDraftEmail(e.target.value)}
                              />
                            </div>
                          ) : u.email ? (
                            <span className="text-xs text-muted-foreground">{u.email}</span>
                          ) : (
                            <span className="text-xs italic text-muted-foreground/60">{t('users.noEmail')}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right align-top tabular-nums text-muted-foreground">
                          {u.plays}
                        </td>
                        <td className="py-2 align-top text-right">
                          {isEditing ? (
                            <span className="inline-flex gap-1">
                              <Button
                                size="sm"
                                disabled={save.isPending}
                                onClick={() => save.mutate({ id: u.id, displayName: draftName, email: draftEmail })}
                              >{t('users.save')}</Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                                {t('users.cancel')}
                              </Button>
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={!canManage}
                              onClick={() => {
                                setEditing(u.id);
                                setDraftName(u.displayName ?? '');
                                setDraftEmail(u.email ?? '');
                              }}
                            >{t('users.edit')}</Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-muted-foreground">{t('users.localNote')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
