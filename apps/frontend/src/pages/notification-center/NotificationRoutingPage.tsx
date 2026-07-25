import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RotateCw } from 'lucide-react';
import { api, type NotificationRecipient, type NotificationRouting, type NotificationRule } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

/** `system.backup_failed` → `system`. */
function namespaceOf(event: string): string {
  const dot = event.indexOf('.');
  return dot > 0 ? event.slice(0, dot) : event;
}

/**
 * A user's personal notification routing profile: which channels deliver which events
 * *to them*.
 *
 * Distinct from the Rules page, which is the admin's global answer to "where does this
 * event go". This page is the per-person answer, and it wins — a rule pinned to email
 * no longer puts Telegram out of reach for someone who wants it. The exception is a
 * rule marked *forced*, shown here as locked, which an admin has pinned deliberately
 * (a security alert nobody should be able to reroute).
 *
 * Rows are namespace-first on purpose. A library carries ~59 events across 7
 * namespaces, so "all system alerts by email" has to be one decision, not twelve; an
 * individual event is only ever touched when it needs to differ from its namespace.
 */
export function NotificationRoutingPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();

  const recipients = useQuery({ queryKey: ['nc', 'recipients'], queryFn: () => api.notificationCenter.recipients() });
  const channels = useQuery({ queryKey: ['nc', 'channels'], queryFn: () => api.notificationCenter.channels() });
  const rules = useQuery({ queryKey: ['nc', 'rules'], queryFn: () => api.notificationCenter.rules() });

  const [recipientId, setRecipientId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const routing = useQuery({
    queryKey: ['nc', 'routing', recipientId],
    queryFn: () => api.notificationCenter.routing(recipientId),
    enabled: !!recipientId,
  });

  const save = useMutation({
    mutationFn: (body: { event: string; channelIds: string[] }) =>
      api.notificationCenter.setRouting({ recipientId, ...body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nc', 'routing', recipientId] });
      toast.success(t('routing.saved'));
    },
    onError: () => toast.error(t('routing.saveFailed')),
  });

  const reconcile = useMutation({
    mutationFn: () => api.notificationCenter.reconcileRecipients(),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['nc', 'recipients'] });
      toast.success(t('routing.reconciled', { created: s.created, adopted: s.adopted }));
    },
    onError: () => toast.error(t('routing.reconcileFailed')),
  });

  const allChannels = channels.data ?? [];
  const enabledChannels = allChannels.filter((c) => c.enabled);

  /** Events grouped by namespace, derived from the rules that exist. */
  const groups = useMemo(() => {
    const map = new Map<string, NotificationRule[]>();
    for (const r of rules.data ?? []) {
      const ns = namespaceOf(r.event);
      if (!map.has(ns)) map.set(ns, []);
      map.get(ns)!.push(r);
    }
    for (const list of map.values()) list.sort((a, b) => a.event.localeCompare(b.event));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rules.data]);

  const byEvent = useMemo(() => {
    const m = new Map<string, NotificationRouting>();
    for (const r of routing.data ?? []) m.set(r.event, r);
    return m;
  }, [routing.data]);

  const defaultChannelNames = allChannels.filter((c) => c.enabled && c.isDefault).map((c) => c.name);

  /** Channels currently chosen for a key, or null when the line is unset (inherit). */
  function selection(key: string): string[] | null {
    const row = byEvent.get(key);
    return row ? row.channelIds : null;
  }

  /**
   * What an event actually resolves to, following the same specificity the backend
   * applies (exact > namespace > catch-all > inherited). Shown so the admin never has
   * to infer where an untouched event lands.
   */
  function effective(event: string): { names: string[]; from: string } {
    const exact = selection(event);
    if (exact?.length) return { names: nameOf(exact), from: t('routing.fromExact') };
    const ns = selection(`${namespaceOf(event)}.*`);
    if (ns?.length) return { names: nameOf(ns), from: t('routing.fromNamespace') };
    const all = selection('*');
    if (all?.length) return { names: nameOf(all), from: t('routing.fromAll') };
    return { names: defaultChannelNames, from: t('routing.fromDefault') };
  }

  function nameOf(ids: string[]): string[] {
    return ids.map((id) => allChannels.find((c) => c.id === id)?.name).filter(Boolean) as string[];
  }

  function toggle(key: string, channelId: string, on: boolean) {
    const current = selection(key) ?? [];
    const next = on ? [...current, channelId] : current.filter((id) => id !== channelId);
    save.mutate({ event: key, channelIds: next });
  }

  /** A checkbox row of channels for one routing key. */
  function ChannelRow({ keyName, disabled }: { keyName: string; disabled?: boolean }) {
    const current = selection(keyName);
    return (
      <div className="flex flex-wrap items-center gap-3">
        {enabledChannels.map((c) => (
          <label key={c.id} className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={(current ?? []).includes(c.id)}
              disabled={disabled || save.isPending}
              onCheckedChange={(v: boolean) => toggle(keyName, c.id, v)}
            />
            {c.name}
          </label>
        ))}
        {current?.length ? (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => save.mutate({ event: keyName, channelIds: [] })}>
            {t('routing.clear')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{t('routing.inherits')}</span>
        )}
      </div>
    );
  }

  if (recipients.isLoading || channels.isLoading || rules.isLoading) return <CenteredSpinner />;
  if (recipients.isError) return <ErrorState title={t('routing.loadError')} onRetry={() => void recipients.refetch()} />;

  const list = recipients.data ?? [];
  const label = (r: NotificationRecipient) =>
    `${r.displayName}${r.userId ? '' : ` — ${t('routing.external')}`}${r.enabled ? '' : ` (${t('routing.disabled')})`}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('routing.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('routing.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
          <RotateCw className="h-3.5 w-3.5" /> {t('routing.syncUsers')}
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-1.5 sm:max-w-sm">
            <Label htmlFor="r-recipient">{t('routing.recipient')}</Label>
            <Select
              id="r-recipient"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              options={[
                { value: '', label: t('routing.selectRecipient') },
                ...list.map((r) => ({ value: r.id, label: label(r) })),
              ]}
            />
          </div>

          {!recipientId ? null : enabledChannels.length === 0 ? (
            <EmptyState title={t('routing.noChannels')} />
          ) : routing.isLoading ? (
            <CenteredSpinner />
          ) : (
            <div className="space-y-4">
              <div className="rounded-md border border-white/5 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <code className="text-xs font-semibold">*</code>
                  <span className="text-xs text-muted-foreground">{t('routing.allEventsHint')}</span>
                </div>
                <ChannelRow keyName="*" />
              </div>

              {groups.map(([ns, evRules]) => (
                <div key={ns} className="rounded-md border border-white/5 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <code className="text-xs font-semibold">{ns}.*</code>
                    <Badge variant="outline">{t('routing.eventCount', { count: evRules.length })}</Badge>
                    <span className="flex-1" />
                    <Button variant="ghost" size="sm" onClick={() => setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(ns)) n.delete(ns); else n.add(ns);
                      return n;
                    })}>
                      {expanded.has(ns) ? t('routing.hideEvents') : t('routing.showEvents')}
                    </Button>
                  </div>
                  <ChannelRow keyName={`${ns}.*`} />

                  {expanded.has(ns) && (
                    <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
                      {evRules.map((r) => {
                        const eff = effective(r.event);
                        return (
                          <div key={r.id} className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="text-[11px]">{r.event}</code>
                              {r.forced && (
                                <Badge variant="secondary" title={t('routing.forcedHint')}>
                                  <Lock className="h-3 w-3" /> {t('routing.forced')}
                                </Badge>
                              )}
                              <span className="text-[11px] text-muted-foreground">
                                {r.forced
                                  ? t('routing.forcedTo', { names: nameOf(r.channelIds).join(', ') })
                                  : t('routing.effective', { names: eff.names.join(', ') || '—', from: eff.from })}
                              </span>
                            </div>
                            {!r.forced && <ChannelRow keyName={r.event} />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
