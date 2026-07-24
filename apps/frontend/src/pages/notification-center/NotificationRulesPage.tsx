import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Radio, Trash2 } from 'lucide-react';
import { api, ApiError, type NotificationRule } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const SEV_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  info: 'secondary', warning: 'outline', critical: 'destructive',
};

/** The rule currently being routed, plus the working copy of its channel selection. */
interface RoutingDraft {
  rule: NotificationRule;
  /** Namespace the rule belongs to — the unit a bulk apply acts on. */
  namespace: string;
  channelIds: string[];
  applyToNamespace: boolean;
}

export function NotificationRulesPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nc', 'rules'], queryFn: () => api.notificationCenter.rules() });
  const channels = useQuery({ queryKey: ['nc', 'channels'], queryFn: () => api.notificationCenter.channels() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nc', 'rules'] });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.notificationCenter.updateRule(id, { enabled }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.notificationCenter.deleteRule(id), onSuccess: invalidate });

  const [draft, setDraft] = useState<RoutingDraft | null>(null);

  const saveRouting = useMutation({
    mutationFn: async (d: RoutingDraft) => {
      const targets = d.applyToNamespace
        ? (q.data ?? []).filter((r) => r.event.split('.')[0] === d.namespace)
        : [d.rule];
      for (const r of targets) await api.notificationCenter.updateRule(r.id, { channelIds: d.channelIds });
      return targets.length;
    },
    onSuccess: (count) => { setDraft(null); toast.success(t('rules.routingSaved', { count })); invalidate(); },
    onError: (e) => toast.error(t('rules.routingSaveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError) return <ErrorState title={t('rules.loadError')} onRetry={() => void q.refetch()} />;

  // Group rules by event namespace (media_server, download, rss, media, system).
  const rules = q.data ?? [];
  const groups = new Map<string, typeof rules>();
  for (const r of rules) {
    const ns = r.event.split('.')[0];
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(r);
  }

  const allChannels = channels.data ?? [];
  const byId = new Map(allChannels.map((c) => [c.id, c]));
  const defaultChannels = allChannels.filter((c) => c.enabled && c.isDefault);

  /**
   * How a rule's routing reads in the row. An empty `channelIds` means "fall back
   * to the default channels" (see channelsFor() in the delivery pipeline), so we
   * name those explicitly rather than leaving the admin to guess where it lands.
   */
  function routingLabel(rule: NotificationRule): string {
    const picked = rule.channelIds.map((id) => byId.get(id)?.name).filter(Boolean) as string[];
    if (picked.length) return picked.join(', ');
    return defaultChannels.length
      ? t('rules.defaultChannels', { names: defaultChannels.map((c) => c.name).join(', ') })
      : t('rules.noDefaultChannel');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('rules.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('rules.subtitle')}</p>
      </div>

      {rules.length === 0 && <EmptyState title={t('rules.empty')} />}

      {[...groups.entries()].map(([ns, list]) => (
        <Card key={ns}>
          <CardContent className="p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`eventGroup.${ns}`, { defaultValue: ns })}</h2>
            <div className="space-y-1">
              {list.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-3 border-t border-white/5 py-1.5 text-sm first:border-0">
                  <Switch checked={r.enabled} onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })} />
                  <span className="font-medium">{r.name}</span>
                  <Badge variant={SEV_VARIANT[r.severity] ?? 'outline'}>{t(`severity.${r.severity}`, { defaultValue: r.severity })}</Badge>
                  <code className="text-xs text-muted-foreground">{r.event}</code>
                  {r.triggerCount > 0 && <span className="text-xs text-muted-foreground">{t('rules.triggered', { count: r.triggerCount })}</span>}
                  <span className="flex-1" />
                  <Button
                    variant="secondary"
                    size="sm"
                    title={t('rules.routeTooltip')}
                    onClick={() => setDraft({ rule: r, namespace: ns, channelIds: [...r.channelIds], applyToNamespace: false })}
                  >
                    <Radio className="h-3.5 w-3.5" />
                    <span className="max-w-[16rem] truncate">{routingLabel(r)}</span>
                  </Button>
                  {!r.system && <Button variant="ghost" size="sm" onClick={() => remove.mutate(r.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      <Dialog open={draft !== null} onClose={() => setDraft(null)} title={draft ? t('rules.routeTitle', { name: draft.rule.name }) : ''}>
        {draft && (
          <>
            <div className="space-y-3 px-4 py-3">
              <p className="text-sm text-muted-foreground">{t('rules.routeHelp')}</p>

              <label className="flex cursor-pointer items-center gap-2.5 rounded border border-border/60 px-2.5 py-2 text-sm">
                <Checkbox
                  checked={draft.channelIds.length === 0}
                  onCheckedChange={() => setDraft({ ...draft, channelIds: [] })}
                  aria-label={t('rules.useDefaults')}
                />
                <span>
                  {t('rules.useDefaults')}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {defaultChannels.length ? defaultChannels.map((c) => c.name).join(', ') : t('rules.noDefaultChannel')}
                  </span>
                </span>
              </label>

              <div className="space-y-1">
                {allChannels.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2.5 px-0.5 py-1 text-sm">
                    <Checkbox
                      checked={draft.channelIds.includes(c.id)}
                      onCheckedChange={(v) =>
                        setDraft({
                          ...draft,
                          channelIds: v ? [...draft.channelIds, c.id] : draft.channelIds.filter((id) => id !== c.id),
                        })
                      }
                      aria-label={c.name}
                    />
                    <span className="font-medium">{c.name}</span>
                    <Badge variant="secondary">{c.provider}</Badge>
                    {!c.enabled && <Badge variant="destructive">{t('rules.channelDisabled')}</Badge>}
                  </label>
                ))}
                {allChannels.length === 0 && <p className="text-sm text-muted-foreground">{t('rules.noChannels')}</p>}
              </div>

              <label className="flex cursor-pointer items-center gap-2.5 border-t border-border/60 pt-3 text-sm">
                <Checkbox
                  checked={draft.applyToNamespace}
                  onCheckedChange={(v) => setDraft({ ...draft, applyToNamespace: v })}
                  aria-label={t('rules.applyToGroup', { group: draft.namespace, count: groups.get(draft.namespace)?.length ?? 0 })}
                />
                <span>
                  {t('rules.applyToGroup', {
                    group: t(`eventGroup.${draft.namespace}`, { defaultValue: draft.namespace }),
                    count: groups.get(draft.namespace)?.length ?? 0,
                  })}
                </span>
              </label>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDraft(null)}>{t('rules.cancel')}</Button>
              <Button onClick={() => saveRouting.mutate(draft)} disabled={saveRouting.isPending}>{t('rules.save')}</Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </div>
  );
}
