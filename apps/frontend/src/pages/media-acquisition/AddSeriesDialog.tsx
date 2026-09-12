import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  ApiError,
  api,
  type SeriesAcquisitionInput,
  type SeriesAcquisitionMode,
  type SeriesSearchHit,
} from '@/lib/api';
import { usePermission } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';

const MODES: SeriesAcquisitionMode[] = ['backfill_and_monitor', 'backfill_only', 'monitor_new_only'];

/** Parse "1, 2, 3" → [1,2,3]; blank → undefined (all seasons). */
function parseSeasons(text: string): number[] | undefined {
  const nums = text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return nums.length ? [...new Set(nums)] : undefined;
}

/** A pasted IMDb (tt…) or TMDB (digits) id → a search hit, so ids work without a search. */
function hitFromId(raw: string): SeriesSearchHit | null {
  const v = raw.trim();
  if (/^tt\d+$/i.test(v)) return { provider: 'imdb', externalIds: { imdb: v.toLowerCase() }, title: v, year: null };
  if (/^\d+$/.test(v)) return { provider: 'tmdb', externalIds: { tmdb: v }, title: `TMDB ${v}`, year: null };
  return null;
}

/**
 * The unified "Add Series" wizard. One dialog: find the show, choose what should
 * happen (backfill / monitor / both), optionally scope to seasons, preview
 * readiness, then provision. Provisioning is idempotent — re-adding links to what
 * exists rather than duplicating.
 */
export function AddSeriesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('seriesAcquisition');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canOverride = usePermission(PERMISSIONS.MEDIA_ACQUISITION_OVERRIDE);

  const [term, setTerm] = useState('');
  const [year, setYear] = useState('');
  const [submittedTerm, setSubmittedTerm] = useState('');
  const [selected, setSelected] = useState<SeriesSearchHit | null>(null);
  const [mode, setMode] = useState<SeriesAcquisitionMode>('backfill_and_monitor');
  const [seasonsText, setSeasonsText] = useState('');
  const [inactiveConfirm, setInactiveConfirm] = useState(false);

  const reset = () => {
    setTerm('');
    setYear('');
    setSubmittedTerm('');
    setSelected(null);
    setMode('backfill_and_monitor');
    setSeasonsText('');
    setInactiveConfirm(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const yearNum = year.trim() ? Number.parseInt(year.trim(), 10) : undefined;

  const search = useQuery({
    queryKey: ['seriesAcquisition', 'search', submittedTerm, yearNum ?? null],
    queryFn: () => api.seriesAcquisition.search(submittedTerm, Number.isNaN(yearNum as number) ? undefined : yearNum),
    enabled: open && submittedTerm.trim().length > 0,
  });

  const input: SeriesAcquisitionInput | null = useMemo(() => {
    if (!selected) return null;
    return {
      title: selected.title,
      year: selected.year ?? (Number.isNaN(yearNum as number) ? undefined : yearNum),
      externalIds: selected.externalIds,
      mode,
      seasons: parseSeasons(seasonsText),
      allowInactiveShowMonitoring: inactiveConfirm || undefined,
    };
  }, [selected, mode, seasonsText, inactiveConfirm, yearNum]);

  const plan = useQuery({
    queryKey: ['seriesAcquisition', 'plan', input],
    queryFn: () => api.seriesAcquisition.plan(input as SeriesAcquisitionInput),
    enabled: open && !!input,
  });

  const provision = useMutation({
    mutationFn: () => api.seriesAcquisition.provision(input as SeriesAcquisitionInput),
    onSuccess: (r) => {
      const key = r.alreadyExisted ? 'addSeries.provision.successExisting' : 'addSeries.provision.success';
      toast.success(t(key, { title: selected?.title ?? '' }));
      void queryClient.invalidateQueries({ queryKey: ['mediaAcquisition'] });
      void queryClient.invalidateQueries({ queryKey: ['media-acquisition'] });
      close();
    },
    onError: (err) =>
      toast.error(t('addSeries.provision.failed'), err instanceof ApiError ? err.message : undefined),
  });

  const manualHit = hitFromId(term);
  const p = plan.data;
  const needsConfirm = p?.requiresInactiveConfirmation ?? false;
  // Ready to provision: the plan says ready, OR the only blocker is the inactive
  // confirmation and the operator (with permission) has ticked it.
  const canProvision =
    !!p &&
    (p.ready || (needsConfirm && inactiveConfirm && canOverride && p.blockers.length <= 1));

  return (
    <Dialog open={open} onClose={close} title={t('addSeries.title')}>
      <p className="text-sm text-muted-foreground">{t('addSeries.subtitle')}</p>

      {/* Step 1 — find the series */}
      {!selected ? (
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium">{t('addSeries.search.label')}</label>
          <div className="flex items-center gap-2">
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setSubmittedTerm(term)}
              placeholder={t('addSeries.search.placeholder')}
            />
            <Input
              className="w-24"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder={t('addSeries.search.yearPlaceholder')}
            />
            <Button variant="secondary" onClick={() => setSubmittedTerm(term)} disabled={!term.trim()}>
              {t('addSeries.search.button')}
            </Button>
          </div>

          {manualHit && (
            <button
              type="button"
              className="w-full rounded-md border border-border/60 px-3 py-2 text-left text-sm hover:bg-white/[0.03]"
              onClick={() => setSelected(manualHit)}
            >
              {t('addSeries.search.idPasted')} <Badge variant="outline">{manualHit.provider}</Badge>
            </button>
          )}

          <div className="max-h-[40vh] overflow-y-auto rounded-md border border-border/60">
            {search.isFetching ? (
              <CenteredSpinner label={t('addSeries.search.searching')} />
            ) : submittedTerm && (search.data?.length ?? 0) === 0 ? (
              <EmptyState title={t('addSeries.search.empty')} />
            ) : (
              (search.data ?? []).map((hit, i) => (
                <button
                  type="button"
                  key={`${hit.provider}-${Object.values(hit.externalIds)[0] ?? i}`}
                  className="flex w-full items-center gap-3 border-b border-border/40 px-3 py-2 text-left last:border-0 hover:bg-white/[0.02]"
                  onClick={() => setSelected(hit)}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{hit.title}</span>
                  {hit.year != null && <span className="text-xs text-muted-foreground">({hit.year})</span>}
                  <Badge variant="outline">{hit.provider}</Badge>
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {/* Selected series */}
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {selected.title}
                {selected.year != null && (
                  <span className="ml-1 text-xs text-muted-foreground">({selected.year})</span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">{t('addSeries.selected.label')}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              {t('addSeries.selected.change')}
            </Button>
          </div>

          {/* Step 2 — mode */}
          <div>
            <label className="block text-sm font-medium">{t('addSeries.mode.label')}</label>
            <div className="mt-2 space-y-2">
              {MODES.map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left ${
                    mode === m ? 'border-primary bg-primary/10' : 'border-border/60 hover:bg-white/[0.02]'
                  }`}
                >
                  <span
                    className={`mt-0.5 h-4 w-4 flex-none rounded-full border ${
                      mode === m ? 'border-primary bg-primary' : 'border-muted-foreground'
                    }`}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t(`addSeries.mode.${m}.name`)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`addSeries.mode.${m}.description`)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Step 2b — seasons */}
          <div>
            <label className="block text-sm font-medium">{t('addSeries.seasons.label')}</label>
            <Input
              className="mt-1"
              value={seasonsText}
              onChange={(e) => setSeasonsText(e.target.value)}
              placeholder={t('addSeries.seasons.placeholder')}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('addSeries.seasons.hint')}</p>
          </div>

          {/* Step 3 — readiness preview */}
          <div className="rounded-md border border-border/60 p-3">
            <div className="text-sm font-medium">{t('addSeries.plan.title')}</div>
            {plan.isFetching ? (
              <CenteredSpinner label={t('addSeries.plan.checking')} />
            ) : p ? (
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {p.template && <div>{t('addSeries.plan.template', { name: p.template.name })}</div>}
                <div>{t('addSeries.plan.matchPreferences', { reason: p.readiness.reason })}</div>
                <div>
                  {p.existing.watchlistItemId
                    ? t('addSeries.plan.existingLinked', { status: p.existing.status ?? '' })
                    : t('addSeries.plan.existingNew')}
                </div>
                <div>{p.willMonitor ? t('addSeries.plan.willMonitor') : t('addSeries.plan.noBackfill')}</div>
                {p.willBackfill && <div>{t('addSeries.plan.willBackfill')}</div>}
                {p.showStatus && (
                  <div>
                    {p.showStatus.normalizedStatus === 'ended'
                      ? t('addSeries.plan.statusEnded')
                      : p.showStatus.normalizedStatus === 'canceled'
                        ? t('addSeries.plan.statusCanceled')
                        : p.showStatus.normalizedStatus === 'returning'
                          ? t('addSeries.plan.statusReturning')
                          : t('addSeries.plan.statusUnknown')}
                  </div>
                )}

                {/* Ended/canceled show: warning + confirm */}
                {needsConfirm && (
                  <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-warning">
                    <div>{t('addSeries.inactive.warning')}</div>
                    {canOverride ? (
                      <label className="mt-2 flex cursor-pointer items-center gap-2">
                        <Checkbox
                          checked={inactiveConfirm}
                          onCheckedChange={setInactiveConfirm}
                          aria-label={t('addSeries.inactive.confirm')}
                        />
                        <span className="text-xs">{t('addSeries.inactive.confirm')}</span>
                      </label>
                    ) : (
                      <div className="mt-1 text-xs">{t('addSeries.inactive.needsPermission')}</div>
                    )}
                  </div>
                )}

                {/* Remaining hard blockers (other than the inactive confirm) */}
                {p.blockers.length > 0 && !(needsConfirm && p.blockers.length === 1) && (
                  <div className="mt-2 text-destructive">
                    <div>{t('addSeries.plan.blockers')}</div>
                    <ul className="ml-4 list-disc">
                      {p.blockers.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {canProvision && <div className="text-success">{t('addSeries.plan.ready')}</div>}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          {t('addSeries.cancel')}
        </Button>
        {selected && (
          <Button
            onClick={() => provision.mutate()}
            loading={provision.isPending}
            disabled={!canProvision || provision.isPending}
          >
            {t('addSeries.provision.button')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
