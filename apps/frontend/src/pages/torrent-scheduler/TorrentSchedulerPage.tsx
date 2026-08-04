import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Gauge, Info, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { ApiError, api, type SchedulerMode } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatRelativeTime } from '@/lib/format';
import { SchedulerPolicies } from './SchedulerPolicies';
import { ActivationDialog, DeactivationDialog } from './ActivationDialog';

/**
 * Observe Only.
 *
 * The page's job is to answer "why is this torrent waiting" and "what would
 * change if I turned this on" — not to look busy. So the proposed-change count
 * is the headline: it is the size of the gap between the engine's queue and the
 * operator's policy, and it is the number that decides whether enabling
 * enforcement later is safe.
 *
 * Every limitation the engine has is shown rather than hidden. A queue view that
 * quietly omits "this engine cannot report which torrents are queued" would let
 * an operator trust an inferred answer as a measured one.
 */
export function TorrentSchedulerPage() {
  const { t } = useTranslation('torrents');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManageMode = hasPermission(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_ENGINE_MODE);

  const engines = useQuery({
    queryKey: ['torrent-scheduler', 'engines'],
    queryFn: api.torrentScheduler.engines,
  });

  const [selected, setSelected] = useState<string | null>(null);
  // Enforcement is never reached by picking an option — it goes through a dialog
  // that shows the operator the exact torrents affected first.
  const [activating, setActivating] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const engineId = selected ?? engines.data?.[0]?.engineId ?? null;
  const engine = engines.data?.find((e) => e.engineId === engineId) ?? null;

  const plan = useQuery({
    queryKey: ['torrent-scheduler', 'preview', engineId],
    queryFn: () => api.torrentScheduler.preview(engineId as string),
    // Only observing engines have a plan worth showing; a native engine is
    // deliberately not planned at all, so asking would return nothing useful.
    enabled: !!engineId && engine?.mode !== 'native',
  });

  const setMode = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: SchedulerMode }) =>
      api.torrentScheduler.setMode(id, mode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['torrent-scheduler'] });
    },
    onError: (err) =>
      toast.error(t('scheduler.modeChangeFailed'), err instanceof ApiError ? err.message : undefined),
  });

  if (engines.isLoading) return <CenteredSpinner />;
  if (engines.isError) return <ErrorState title={t('scheduler.loadError')} onRetry={() => engines.refetch()} />;
  if (!engines.data?.length) {
    return <EmptyState icon={<Gauge className="h-8 w-8" />} title={t('scheduler.noEngines')} />;
  }

  const proposed = plan.data?.decisions.filter((d) => d.action !== 'none') ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('scheduler.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('scheduler.subtitle')}</p>
      </div>

      {/* Said plainly and always, not as a dismissible hint: the entire value of
          this page depends on the operator knowing nothing is being applied. */}
      {/* Only true while nothing is enforcing. Leaving it up under managed mode
          would tell an operator nothing is being applied while it is. */}
      {engines.data.every((e) => e.mode !== 'managed') && (
        <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/5 px-3 py-2 text-sm">
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-info" />
          <span>{t('scheduler.observeNotice')}</span>
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-muted-foreground" htmlFor="scheduler-engine">
                {t('scheduler.engine')}
              </label>
              <Select
                id="scheduler-engine"
                className="mt-1 w-auto"
                value={engineId ?? ''}
                onChange={(e) => setSelected(e.target.value)}
              >
                {engines.data.map((e) => (
                  <option key={e.engineId} value={e.engineId}>{e.engineId} ({e.kind})</option>
                ))}
              </Select>
            </div>

            {engine && (
              <div>
                <label className="text-xs text-muted-foreground" htmlFor="scheduler-mode">
                  {t('scheduler.mode.label')}
                </label>
                <Select
                  id="scheduler-mode"
                  className="mt-1 w-auto"
                  value={engine.mode}
                  disabled={!canManageMode || setMode.isPending}
                  onChange={(e) => {
                    const next = e.target.value as SchedulerMode;
                    // Choosing enforcement opens the consent dialog; leaving it
                    // asks what to do with the torrents it is holding paused.
                    if (next === 'managed') { setActivating(engine.engineId); return; }
                    if (engine.mode === 'managed') { setDeactivating(engine.engineId); return; }
                    setMode.mutate({ id: engine.engineId, mode: next });
                  }}
                >
                  <option value="native">{t('scheduler.mode.native')}</option>
                  <option value="observe">{t('scheduler.mode.observe')}</option>
                  <option value="managed">{t('scheduler.mode.managed')}</option>
                </Select>
              </div>
            )}

            {engine?.mode !== 'native' && (
              <Button variant="outline" onClick={() => plan.refetch()} loading={plan.isFetching}>
                <RefreshCw className="mr-1.5 h-4 w-4" /> {t('scheduler.refresh')}
              </Button>
            )}
          </div>

          {engine && (
            <>
              <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {t(`scheduler.modeHelp.${engine.mode}` as 'scheduler.modeHelp.native')}
              </p>
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-muted-foreground">
                  {t('scheduler.health.label')}:{' '}
                  <Badge variant={engine.healthState === 'healthy' ? 'success' : 'secondary'}>
                    {t(`scheduler.health.${engine.healthState}` as 'scheduler.health.unknown')}
                  </Badge>
                </span>
                <span className="text-muted-foreground">
                  {t('scheduler.lastSweep')}:{' '}
                  {engine.lastSweepAt ? formatRelativeTime(engine.lastSweepAt) : t('scheduler.never')}
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {canManageMode && <SchedulerPolicies />}

      {activating && (
        <ActivationDialog
          engineId={activating}
          onClose={() => setActivating(null)}
          onDone={() => {
            setActivating(null);
            queryClient.invalidateQueries({ queryKey: ['torrent-scheduler'] });
          }}
        />
      )}
      {deactivating && (
        <DeactivationDialog
          engineId={deactivating}
          onClose={() => setDeactivating(null)}
          onDone={() => {
            setDeactivating(null);
            queryClient.invalidateQueries({ queryKey: ['torrent-scheduler'] });
          }}
        />
      )}

      {engine?.mode === 'native' ? null : plan.isLoading ? (
        <CenteredSpinner />
      ) : plan.data ? (
        <>
          <Card>
            <CardContent className="p-5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label={t('scheduler.summary.activeDownloads')} value={plan.data.summary.activeDownloads} />
                <Stat label={t('scheduler.summary.activeSeeds')} value={plan.data.summary.activeSeeds} />
                <Stat label={t('scheduler.summary.totalActive')} value={plan.data.summary.totalActive} />
                <Stat label={t('scheduler.summary.queuedDownloads')} value={plan.data.summary.queuedDownloads} />
                <Stat label={t('scheduler.summary.queuedSeeds')} value={plan.data.summary.queuedSeeds} />
                <Stat label={t('scheduler.summary.proposed')} value={proposed.length} emphasis />
              </div>
              <p className="mt-4 text-sm text-muted-foreground">
                {proposed.length === 0
                  ? t('scheduler.proposedNone')
                  : t('scheduler.proposedSome', { count: proposed.length })}
              </p>
            </CardContent>
          </Card>

          {plan.data.limitations.length > 0 && (
            <Card>
              <CardContent className="space-y-2 p-5">
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  <ShieldAlert className="h-4 w-4 text-warning" />
                  {t('scheduler.limitation.title')}
                </h2>
                {plan.data.limitations.map((l) => (
                  <p key={l.code} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <span>{t(`scheduler.limitation.${l.code}` as 'scheduler.limitation.no_pause_support')}</span>
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border/60 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2">{t('scheduler.table.torrent')}</th>
                      <th className="px-4 py-2">{t('scheduler.table.desired')}</th>
                      <th className="px-4 py-2">{t('scheduler.table.reason')}</th>
                      <th className="px-4 py-2 text-right">{t('scheduler.table.score')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Proposed changes first — they are what the operator came
                        for. An unchanged torrent explains itself on request. */}
                    {[...plan.data.decisions]
                      .sort((a, b) => Number(b.action !== 'none') - Number(a.action !== 'none') || b.score - a.score)
                      .slice(0, 200)
                      .map((d) => (
                        <tr key={d.hash} className="border-b border-border/40 last:border-0">
                          <td className="px-4 py-2 font-mono text-xs">{d.hash.slice(0, 12)}</td>
                          <td className="px-4 py-2">
                            <Badge variant={d.action === 'none' ? 'secondary' : 'warning'}>
                              {t(`scheduler.desired.${d.desiredState}` as 'scheduler.desired.active')}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {t(`scheduler.reason.${d.reasonCode}` as 'scheduler.reason.verifying', d.values ?? {})}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{d.score}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <EmptyState
          icon={<Info className="h-8 w-8" />}
          title={t('scheduler.modeHelp.native')}
        />
      )}
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-semibold tabular-nums ${emphasis && value > 0 ? 'text-warning' : ''}`}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
