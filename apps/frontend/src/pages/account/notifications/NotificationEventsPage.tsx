import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, Minus, RotateCcw, X } from 'lucide-react';
import {
  api,
  type AccountBulkAction,
  type AccountNotificationEventRow,
  type NotificationChannelType,
  type NotificationDeliveryMode,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { EMPTY_FILTERS, EventMatrixFilters, type EventFilters } from './EventMatrixFilters';

const CHANNELS: NotificationChannelType[] = ['in_app', 'email', 'telegram', 'whatsapp', 'discord'];
const MODES: NotificationDeliveryMode[] = [
  'immediate', 'quiet_hours_queue', 'daily_digest', 'weekly_digest', 'disabled',
];

/** Severity → badge variant. Never the ONLY signal: the label is always present. */
const SEV_VARIANT: Record<string, 'outline' | 'secondary' | 'destructive'> = {
  info: 'outline', success: 'secondary', warning: 'secondary',
  error: 'destructive', critical: 'destructive', security: 'destructive',
};

/**
 * The personal event matrix — one row per registered notification event, showing what
 * *this* user receives and where.
 *
 * Everything here is scoped to the authenticated user by the API, which takes the
 * identity from the JWT; there is no user selector because there is nothing to select.
 *
 * Channel state is never conveyed by colour alone: each cell carries an icon, a text
 * label and a title, so it reads the same to a screen reader and in monochrome.
 */
export function NotificationEventsPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();

  const [filters, setFilters] = useState<EventFilters>({ ...EMPTY_FILTERS });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<AccountNotificationEventRow | null>(null);

  const events = useQuery({
    queryKey: ['account', 'notifications', 'events'],
    queryFn: () => api.account.notifications.events(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['account', 'notifications', 'events'] });

  const setPref = useMutation({
    mutationFn: (v: { eventKey: string; deliveryMode?: NotificationDeliveryMode; enabled?: boolean }) =>
      api.account.notifications.setPreference(v.eventKey, {
        deliveryMode: v.deliveryMode, enabled: v.enabled,
      }),
    onSuccess: () => { void invalidate(); toast.success(t('matrix.saved')); },
    onError: () => toast.error(t('matrix.saveFailed')),
  });

  const setRoutes = useMutation({
    mutationFn: (v: { eventKey: string; routes: AccountNotificationEventRow['preference']['routes'] }) =>
      api.account.notifications.setRoutes(
        v.eventKey,
        v.routes.map((r) => ({ channelType: r.channelType, channelConnectionId: r.channelConnectionId })),
      ),
    onSuccess: () => { void invalidate(); toast.success(t('matrix.saved')); },
    onError: (e: Error) => toast.error(e?.message || t('matrix.saveFailed')),
  });

  const bulk = useMutation({
    mutationFn: (action: AccountBulkAction) => api.account.notifications.bulk([...selected], action),
    onSuccess: (r) => {
      void invalidate();
      setSelected(new Set());
      // Skips are surfaced, never swallowed — "applied 37 of 40" is the honest
      // report when some events do not support the channel.
      if (r.skipped.length) toast.info(t('matrix.bulkPartial', { applied: r.applied, skipped: r.skipped.length }));
      else toast.success(t('matrix.bulkApplied', { count: r.applied }));
    },
    onError: (e: Error) => toast.error(e?.message || t('matrix.saveFailed')),
  });

  const resetEvent = useMutation({
    mutationFn: (eventKey: string) => api.account.notifications.resetEvent(eventKey),
    onSuccess: () => { void invalidate(); toast.success(t('matrix.resetDone')); },
  });

  const rows = events.data ?? [];

  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.definition.category, (m.get(r.definition.category) ?? 0) + 1);
    return [...m.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => a.category.localeCompare(b.category));
  }, [rows]);

  const visible = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return rows.filter((r) => {
      const { definition: d, preference: p } = r;
      if (q) {
        const hay = `${d.key} ${t(d.titleKey, { defaultValue: d.key })} ${d.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.categories.size && !filters.categories.has(d.category)) return false;
      if (filters.severities.size && !filters.severities.has(d.severity)) return false;
      if (filters.deliveryModes.size && !filters.deliveryModes.has(p.deliveryMode)) return false;
      if (filters.channels.size) {
        const used = new Set(p.routes.map((x) => x.channelType));
        if (![...filters.channels].some((c) => used.has(c))) return false;
      }
      if (filters.states.size) {
        const states = new Set<string>();
        states.add(p.enabled ? 'enabled' : 'disabled');
        states.add(p.isDefault ? 'default' : 'customized');
        // A route that names no connection cannot deliver — worth filtering for.
        if (p.routes.some((x) => x.channelType !== 'in_app' && !x.channelConnectionId)) states.add('missing_channel');
        if (![...filters.states].some((s) => states.has(s))) return false;
      }
      return true;
    });
  }, [rows, filters, t]);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.definition.key));

  function toggleRow(key: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  /** Toggle one channel on an event, preserving the other routes. */
  function toggleChannel(row: AccountNotificationEventRow, channelType: NotificationChannelType) {
    const current = row.preference.routes;
    const has = current.some((r) => r.channelType === channelType);
    const next = has
      ? current.filter((r) => r.channelType !== channelType)
      : [...current, { channelType, channelConnectionId: null, enabled: true, deliveryMode: null }];
    setRoutes.mutate({ eventKey: row.definition.key, routes: next });
  }

  if (events.isLoading) return <CenteredSpinner />;
  if (events.isError) {
    return <ErrorState title={t('matrix.loadError')} onRetry={() => void events.refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Bell className="h-5 w-5" /> {t('matrix.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('matrix.subtitle')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (confirm(t('matrix.resetAllConfirm'))) {
              void api.account.notifications.resetAll().then(() => { void invalidate(); toast.success(t('matrix.resetDone')); });
            }
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" /> {t('matrix.resetAll')}
        </Button>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <EventMatrixFilters filters={filters} onChange={setFilters} categoryCounts={categoryCounts} />

        <div className="min-w-0 flex-1 space-y-3">
          {/* Bulk toolbar — only present when a selection exists. */}
          {selected.size > 0 && (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2 p-3">
                <span className="text-sm font-medium">{t('matrix.selected', { count: selected.size })}</span>
                <span className="flex-1" />
                <Button size="sm" variant="secondary" onClick={() => bulk.mutate({ kind: 'set_enabled', enabled: true })}>
                  {t('matrix.bulk.enable')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => bulk.mutate({ kind: 'set_enabled', enabled: false })}>
                  {t('matrix.bulk.disable')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => bulk.mutate({ kind: 'enable_channel', channelType: 'in_app' })}>
                  {t('matrix.bulk.enableInApp')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => bulk.mutate({ kind: 'disable_channel', channelType: 'in_app' })}>
                  {t('matrix.bulk.disableInApp')}
                </Button>
                <Select
                  aria-label={t('matrix.bulk.setMode')}
                  value=""
                  onChange={(e) => e.target.value && bulk.mutate({ kind: 'set_delivery_mode', deliveryMode: e.target.value as NotificationDeliveryMode })}
                  options={[
                    { value: '', label: t('matrix.bulk.setMode') },
                    ...MODES.map((m) => ({ value: m, label: t(`matrix.mode.${m}`) })),
                  ]}
                />
                <Button size="sm" variant="ghost" onClick={() => bulk.mutate({ kind: 'reset' })}>
                  {t('matrix.bulk.reset')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-muted-foreground">
            {t('matrix.showing', { visible: visible.length, total: rows.length })}
          </p>

          {visible.length === 0 ? (
            <EmptyState title={t('matrix.noMatches')} />
          ) : (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full table-fixed border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="w-10 p-2">
                        <Checkbox
                          aria-label={t('matrix.selectAll')}
                          checked={allVisibleSelected}
                          onCheckedChange={() =>
                            setSelected(allVisibleSelected ? new Set() : new Set(visible.map((r) => r.definition.key)))
                          }
                        />
                      </th>
                      <th className="p-2">{t('matrix.col.event')}</th>
                      <th className="w-28 p-2">{t('matrix.col.category')}</th>
                      <th className="w-24 p-2">{t('matrix.col.severity')}</th>
                      {CHANNELS.map((c) => (
                        <th key={c} className="w-20 p-2 text-center">{t(`matrix.channel.${c}`)}</th>
                      ))}
                      <th className="w-40 p-2">{t('matrix.col.whenToSend')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {visible.map((row) => {
                      const { definition: d, preference: p } = row;
                      const routed = new Set(p.routes.map((r) => r.channelType));
                      return (
                        <tr key={d.key} className={p.enabled ? undefined : 'opacity-60'}>
                          <td className="p-2 align-top">
                            <Checkbox
                              aria-label={t('matrix.selectRow', { name: t(d.titleKey, { defaultValue: d.key }) })}
                              checked={selected.has(d.key)}
                              onCheckedChange={() => toggleRow(d.key)}
                            />
                          </td>
                          <td className="p-2 align-top">
                            <button
                              type="button"
                              className="text-left font-medium hover:underline"
                              onClick={() => setDrawer(row)}
                            >
                              {t(d.titleKey, { defaultValue: d.key })}
                            </button>
                            <p className="truncate font-mono text-[11px] text-muted-foreground">{d.key}</p>
                            {!p.isDefault && (
                              <Badge variant="outline" className="mt-1">{t('matrix.customized')}</Badge>
                            )}
                          </td>
                          <td className="p-2 align-top text-xs">
                            {t(`matrix.category.${d.category}`, { defaultValue: d.category })}
                          </td>
                          <td className="p-2 align-top">
                            <Badge variant={SEV_VARIANT[d.severity] ?? 'outline'}>
                              {t(`matrix.severity.${d.severity}`)}
                            </Badge>
                          </td>
                          {CHANNELS.map((c) => {
                            const supported = d.supportedChannels.includes(c);
                            const on = routed.has(c);
                            // Not colour alone: an icon plus an accessible label.
                            const label = !supported
                              ? t('matrix.cell.unsupported')
                              : on ? t('matrix.cell.enabled') : t('matrix.cell.disabled');
                            return (
                              <td key={c} className="p-2 text-center align-top">
                                <button
                                  type="button"
                                  disabled={!supported || setRoutes.isPending}
                                  title={`${t(`matrix.channel.${c}`)} — ${label}`}
                                  aria-label={`${t(d.titleKey, { defaultValue: d.key })}: ${t(`matrix.channel.${c}`)} ${label}`}
                                  aria-pressed={on}
                                  onClick={() => toggleChannel(row, c)}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 disabled:opacity-30"
                                >
                                  {!supported ? <Minus className="h-3 w-3" />
                                    : on ? <Check className="h-3.5 w-3.5 text-success" />
                                    : <X className="h-3 w-3 text-muted-foreground" />}
                                </button>
                              </td>
                            );
                          })}
                          <td className="p-2 align-top">
                            <Select
                              aria-label={t('matrix.col.whenToSend')}
                              value={p.deliveryMode}
                              onChange={(e) =>
                                setPref.mutate({ eventKey: d.key, deliveryMode: e.target.value as NotificationDeliveryMode })
                              }
                              options={MODES.map((m) => ({ value: m, label: t(`matrix.mode.${m}`) }))}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Event detail drawer */}
      <Dialog
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        title={drawer ? t(drawer.definition.titleKey, { defaultValue: drawer.definition.key }) : ''}
      >
        {drawer && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {t(drawer.definition.descriptionKey, { defaultValue: t('matrix.noDescription') })}
            </p>
            <dl className="grid grid-cols-2 gap-2">
              <dt className="text-xs text-muted-foreground">{t('matrix.col.category')}</dt>
              <dd>{t(`matrix.category.${drawer.definition.category}`, { defaultValue: drawer.definition.category })}</dd>
              <dt className="text-xs text-muted-foreground">{t('matrix.col.severity')}</dt>
              <dd>{t(`matrix.severity.${drawer.definition.severity}`)}</dd>
              <dt className="text-xs text-muted-foreground">{t('matrix.drawer.audience')}</dt>
              <dd>{t(`matrix.audience.${drawer.definition.audience}`, { defaultValue: drawer.definition.audience })}</dd>
              <dt className="text-xs text-muted-foreground">{t('matrix.drawer.supported')}</dt>
              <dd>{drawer.definition.supportedChannels.map((c) => t(`matrix.channel.${c}`)).join(', ')}</dd>
              <dt className="text-xs text-muted-foreground">{t('matrix.drawer.routes')}</dt>
              <dd>
                {drawer.preference.routes.length
                  ? drawer.preference.routes.map((r) => t(`matrix.channel.${r.channelType}`)).join(', ')
                  : t('matrix.drawer.noRoutes')}
              </dd>
              <dt className="text-xs text-muted-foreground">{t('matrix.col.whenToSend')}</dt>
              <dd>{t(`matrix.mode.${drawer.preference.deliveryMode}`)}</dd>
              <dt className="text-xs text-muted-foreground">{t('matrix.drawer.quietHours')}</dt>
              <dd>{t(`matrix.quiet.${drawer.preference.quietHoursBehavior}`)}</dd>
            </dl>
            {drawer.definition.sensitivity === 'security' && (
              <Badge variant="destructive">{t('matrix.drawer.securityEvent')}</Badge>
            )}
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { resetEvent.mutate(drawer.definition.key); setDrawer(null); }}
              >
                <RotateCcw className="h-3.5 w-3.5" /> {t('matrix.drawer.restoreDefault')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setDrawer(null)}>
                {t('matrix.drawer.close')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
