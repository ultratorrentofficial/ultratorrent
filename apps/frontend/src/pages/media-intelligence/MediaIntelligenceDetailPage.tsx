import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import {
  MEDIA_INTELLIGENCE_DOMAINS,
  type LifecycleDrift,
  type MediaQualityFacts,
  type MediaFinding,
  type MediaIntelligenceDomain,
  type MediaIntelligenceEntityType,
  type UnifiedMediaState,
} from '@ultratorrent/shared';

import { ApiError, api, type MediaArtwork, type MediaItemDetail, type ShowDetail } from '@/lib/api';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTimeShort } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { humanizeFields, prettifyValue } from '@/lib/humanize';
import { MediaPoster } from '@/components/media/MediaPoster';
import {
  FACT_STATUS_VARIANT,
  HEALTH_VARIANT,
  QUALITY_RESULT_VARIANT,
  QUALITY_VARIANT,
  SEVERITY_ORDER,
  SEVERITY_VARIANT,
} from './mediaIntelligenceUi';

/**
 * The unified state of one media entity.
 *
 * Assembled live rather than read from the projection: a single entity is cheap
 * to gather, and a detail page that showed yesterday's conclusions would be
 * worse than one that takes a moment longer. Findings carry their stored
 * lifecycle, so "missing since the 3rd" survives re-evaluation.
 */
export function MediaIntelligenceDetailPage() {
  const { t } = useTranslation('mediaIntelligence');
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const params = useParams<{ entityType: string; entityId: string }>();
  const entityType = params.entityType as MediaIntelligenceEntityType;
  const entityId = params.entityId ?? '';

  const state = useQuery({
    queryKey: ['mediaIntelligence', 'detail', entityType, entityId],
    queryFn: () => api.mediaIntelligence.detail(entityType, entityId),
    enabled: Boolean(entityType && entityId),
  });

  const refresh = useMutation({
    mutationFn: () => api.mediaIntelligence.refresh(entityType, entityId),
    onSuccess: () => {
      toast.success(t('detail.refreshed'));
      void queryClient.invalidateQueries({ queryKey: ['mediaIntelligence'] });
    },
    onError: (err) =>
      toast.error(t('detail.refreshFailed'), err instanceof ApiError ? err.message : undefined),
  });

  if (state.isLoading) return <CenteredSpinner label={t('title')} />;
  if (state.isError) {
    const notFound = state.error instanceof ApiError && state.error.status === 404;
    return (
      <ErrorState
        title={notFound ? t('detail.notFound') : t('detail.error')}
        message={state.error instanceof ApiError ? state.error.message : undefined}
        // A vanished entity has nothing to retry — offering the button would
        // promise a recovery that cannot happen.
        onRetry={
          notFound
            ? undefined
            : () => {
                void state.refetch();
              }
        }
      />
    );
  }

  const s = state.data as UnifiedMediaState;
  const identity = s.identity;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/media/intelligence')}>
            <ArrowLeft className="h-4 w-4" /> {t('detail.back')}
          </Button>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            {identity.title ?? '—'}
            {identity.year ? <span className="ml-2 text-muted-foreground">({identity.year})</span> : null}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={HEALTH_VARIANT[s.health.status]} dot>
              {t(`health.${s.health.status}` as 'health.healthy')}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {s.health.score == null
                ? t('health.noScore')
                : `${t('health.score')}: ${s.health.score}`}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('detail.assembledAt', { when: formatDateTime(s.freshness.assembledAt) })}
            </span>
          </div>
        </div>
        <Button variant="secondary" onClick={() => refresh.mutate()} loading={refresh.isPending}>
          <RefreshCw className="h-4 w-4" /> {t('detail.refresh')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t('advisory')}</p>

      <MediaHeader entityType={entityType} entityId={entityId} />

      <QualityCard state={s} />

      <DriftCard entityType={entityType} entityId={entityId} />

      <Card>
        <CardContent className="space-y-3 py-4">
          <h2 className="text-sm font-semibold">{t('detail.findings')}</h2>
          {s.findings.length === 0 ? (
            <EmptyState title={t('detail.noFindings')} />
          ) : (
            <div className="space-y-2">
              {[...s.findings]
                .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
                .map((f) => (
                  <FindingRow key={f.code} finding={f} />
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 py-4">
          <h2 className="text-sm font-semibold">{t('detail.sections')}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {MEDIA_INTELLIGENCE_DOMAINS.map((d) => (
              <DomainCard key={d} domain={d} section={sectionOf(s, d)} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Drift status → badge. `unknown` is outline, never a success or a warning. */
const DRIFT_VARIANT: Record<LifecycleDrift['status'], 'success' | 'warning' | 'outline'> = {
  compliant: 'success',
  drift: 'warning',
  not_applicable: 'outline',
  unknown: 'outline',
};

/**
 * Desired state versus actual, for one title.
 *
 * Kept in its own query rather than folded into the detail payload: an
 * installation with no policies should pay nothing for this, and the section
 * then renders the honest empty state instead of an error.
 *
 * The section is deliberately a COMPARISON, not a plan. It never offers to
 * fix anything — Phase 5 explains what should be maintained and stops there.
 */
function DriftCard({
  entityType,
  entityId,
}: {
  entityType: MediaIntelligenceEntityType;
  entityId: string;
}) {
  const { t } = useTranslation('mediaIntelligence');

  const evaluation = useQuery({
    queryKey: ['mediaIntelligence', 'drift', entityType, entityId],
    queryFn: () => api.mediaIntelligence.drift(entityType, entityId),
    enabled: Boolean(entityType && entityId),
  });

  // A failure here must not take the page down; the rest of the detail is
  // still true. Staying silent is the right call for a supplementary section.
  if (evaluation.isLoading || evaluation.isError || !evaluation.data) return null;

  const { desiredState, drifts, evaluatedAt } = evaluation.data;
  const governed = drifts.filter((d) => d.status !== 'not_applicable');

  return (
    <Card>
      <CardContent className="space-y-3 py-4" data-testid="drift-section">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('drift.title')}</h2>
          <span className="text-xs text-muted-foreground">
            {t('drift.evaluatedAt', { when: formatDateTime(evaluatedAt) })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{t('drift.subtitle')}</p>

        {governed.length === 0 ? (
          <EmptyState title={t('drift.none')} description={t('drift.noneHint')} />
        ) : (
          <div className="space-y-2">
            {governed.map((d) => (
              <DriftRow key={d.dimension} drift={d} />
            ))}
          </div>
        )}

        {desiredState.conflicts.map((c) => (
          <p key={c.dimension} className="text-xs text-warning">
            {t('drift.conflict', {
              dimension: t(`drift.dimension.${c.dimension}` as 'drift.dimension.quality'),
            })}{' '}
            <span className="text-muted-foreground">{t('drift.conflictHint')}</span>
          </p>
        ))}

        <p className="text-xs text-muted-foreground">{t('drift.advisory')}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Render a desired or actual value.
 *
 * These are typed `unknown` because a dimension's value genuinely varies: a
 * quality intent is a code, `subtitleLanguages` is a list, `acquisition` is an
 * object. `prettifyValue` takes a string, so passing these through it would
 * either fail to compile or — worse, behind a cast — print `[object Object]`
 * at an operator who is trying to understand a verdict.
 */
function driftValue(value: unknown): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : '—';
  if (typeof value === 'string') return prettifyValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // An object dimension has no honest one-line form; say so rather than guess.
  return '—';
}

/** One dimension's verdict, with the policy that asked for it. */
function DriftRow({ drift }: { drift: LifecycleDrift }) {
  const { t } = useTranslation('mediaIntelligence');

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
      <Badge variant={DRIFT_VARIANT[drift.status]} dot>
        {t(`drift.status.${drift.status}` as 'drift.status.compliant')}
      </Badge>
      <span className="text-sm font-medium">
        {t(`drift.dimension.${drift.dimension}` as 'drift.dimension.quality')}
      </span>

      {/* An unknown states WHY, and never shows a comparison it cannot make. */}
      {drift.status === 'unknown' && drift.unknownReason ? (
        <span className="text-xs text-muted-foreground">
          {t('detail.unknownBecause', {
            reason: t(
              `drift.unknownReason.${drift.unknownReason}` as 'drift.unknownReason.quality_not_measured',
            ),
          })}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {t('drift.desired')}: {driftValue(drift.desired)}
          {drift.actual == null ? null : <> · {t('drift.actual')}: {driftValue(drift.actual)}</>}
        </span>
      )}

      {drift.source ? (
        <span className="ml-auto text-xs text-muted-foreground">
          {t('drift.source', { policy: drift.source.policyName })}
        </span>
      ) : null}
    </div>
  );
}

/** The poster to show: the selected one, else any poster, else anything. */
function pickPoster(art: MediaArtwork[] | undefined, seasonNumber: number | null): MediaArtwork | null {
  const all = art ?? [];
  // A season asks for its own poster first; a show-level one is the fallback.
  const scoped = seasonNumber == null ? all : all.filter((a) => a.seasonNumber === seasonNumber);
  const pool = scoped.length > 0 ? scoped : all.filter((a) => a.seasonNumber == null);
  return (
    pool.find((a) => a.type === 'poster' && a.selected) ??
    pool.find((a) => a.type === 'poster') ??
    pool[0] ??
    null
  );
}

/** `showId:seasonNumber` — the assembler's composite id, split the same way. */
function splitSeasonId(entityId: string): { showId: string; seasonNumber: number | null } {
  const idx = entityId.lastIndexOf(':');
  if (idx <= 0) return { showId: entityId, seasonNumber: null };
  const n = Number(entityId.slice(idx + 1));
  return Number.isInteger(n)
    ? { showId: entityId.slice(0, idx), seasonNumber: n }
    : { showId: entityId, seasonNumber: null };
}

/**
 * The title's artwork and metadata, read from the domain that owns them.
 *
 * Deliberately a SEPARATE fetch rather than new fields on `UnifiedMediaState`.
 * Media Intelligence owns conclusions, not source facts: a poster and an
 * overview belong to the Media Manager, and copying them into this layer --
 * worse, into the materialized projection -- would give the same fact two
 * homes and two ways to go stale. Composing at render time costs one request
 * and keeps the ownership boundary honest.
 *
 * Its absence is never an error here. A title with no metadata yet is a normal
 * state (and is itself one of the things Intelligence reports), so a failed or
 * empty lookup renders nothing rather than an error panel over a page whose
 * actual subject -- the health verdict -- loaded fine.
 */
function MediaHeader({
  entityType,
  entityId,
}: {
  entityType: MediaIntelligenceEntityType;
  entityId: string;
}) {
  const { t } = useTranslation('mediaIntelligence');
  const isShowSide = entityType === 'series' || entityType === 'season';
  const { showId, seasonNumber } = isShowSide
    ? splitSeasonId(entityId)
    : { showId: entityId, seasonNumber: null };

  /*
   * The union is stated, not inferred. Two endpoints back this one panel -- a
   * show and an item -- and react-query would otherwise fix the data type to
   * whichever branch it saw first, rejecting the other. The narrowing below
   * uses the same `isShowSide` that chose the endpoint, so the two cannot
   * disagree.
   */
  const q = useQuery<ShowDetail | MediaItemDetail>({
    queryKey: ['mediaIntelligence', 'artwork', entityType, entityId],
    queryFn: () => (isShowSide ? api.media.showDetail(showId) : api.media.getItem(entityId)),
    retry: false,
  });

  if (q.isLoading || q.isError || !q.data) return null;

  const show = isShowSide ? (q.data as ShowDetail) : null;
  const item = isShowSide ? null : (q.data as MediaItemDetail);
  const meta = show ? show.metadata : item?.metadata ?? null;
  const artwork = show ? show.artwork : item?.artwork;
  const poster = pickPoster(artwork, seasonNumber);
  const title = meta?.title ?? show?.show.title ?? item?.title ?? '';

  const genres = meta?.genres ?? [];
  const runtime = item?.metadata?.runtime ?? null;
  const networks = show?.metadata?.networks ?? [];
  const studios = meta?.studios ?? [];
  const directors = item?.metadata?.directors ?? [];
  const status = show?.metadata?.status ?? null;

  // Nothing to add beyond what the header already says.
  if (!poster && !meta) return null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-4 sm:flex-row">
        <MediaPoster
          artwork={poster}
          alt={title || t('media.noArtwork')}
          size="full"
          className="aspect-[2/3] w-28 shrink-0 self-start rounded-md sm:w-36"
        />

        <div className="min-w-0 flex-1 space-y-3">
          {seasonNumber != null ? (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('media.seasonLabel', { number: seasonNumber })}
            </p>
          ) : null}

          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('media.overview')}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-foreground/90">
              {meta?.overview?.trim() || t('media.noOverview')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {genres.slice(0, 6).map((g) => (
              <Badge key={g} variant="secondary">
                {g}
              </Badge>
            ))}
            {meta?.certification ? <Badge variant="outline">{meta.certification}</Badge> : null}
            {status ? <Badge variant="outline">{prettifyValue(status)}</Badge> : null}
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
            {runtime ? (
              <HeaderFact label={t('media.runtime')} value={t('media.runtimeMinutes', { count: runtime })} />
            ) : null}
            {meta?.rating != null ? (
              <HeaderFact label={t('media.rating')} value={meta.rating.toFixed(1)} />
            ) : null}
            {networks.length > 0 ? (
              <HeaderFact label={t('media.network')} value={networks.slice(0, 2).join(', ')} />
            ) : null}
            {studios.length > 0 ? (
              <HeaderFact label={t('media.studio')} value={studios.slice(0, 2).join(', ')} />
            ) : null}
            {directors.length > 0 ? (
              <HeaderFact label={t('media.directedBy')} value={directors.slice(0, 2).join(', ')} />
            ) : null}
          </dl>

          {meta?.providerName ? (
            <p className="text-[11px] text-muted-foreground">
              {t('media.provider', { provider: meta.providerName })}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function HeaderFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{value}</dd>
    </div>
  );
}

/**
 * Quality compliance.
 *
 * Answers, in the order an operator asks them: what do I own, what does my
 * policy want, which rung does this satisfy, and what stops it satisfying a
 * better one. Every number is rendered through the shared humanization
 * helpers — none of this is an `Object.entries` dump.
 *
 * The wording is load-bearing. "Upgrade potential" means a higher rung exists
 * in the operator's OWN ladder; it must never read as "a better release is
 * available", because nothing here has asked an indexer anything.
 */
function QualityCard({ state }: { state: UnifiedMediaState }) {
  const { t } = useTranslation('mediaIntelligence');
  const q = (state as unknown as { quality?: MediaQualityFacts }).quality;
  if (!q) return null;

  const { owned, ladder, compliance: c, aggregate } = q;
  const top = ladder.rungs[0] ?? null;

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('quality.heading')}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={QUALITY_VARIANT[c.status] ?? 'outline'} dot>
              {t(`quality.status.${c.status}` as 'quality.status.preferred')}
            </Badge>
            {c.upgradePotential ? (
              <Badge variant="info">{t('quality.upgradePotential')}</Badge>
            ) : null}
          </div>
        </div>

        {/* The unknown cases say WHY, rather than rendering an empty panel. */}
        {c.status === 'unknown' && c.unknownReason ? (
          <p className="text-sm text-muted-foreground">
            {t(`quality.unknownReason.${c.unknownReason}` as 'quality.unknownReason.no_measured_quality')}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <QualityColumn label={t('quality.current')}>
            {owned ? (
              <>
                <Line value={owned.resolutionClass} />
                <Line value={owned.videoCodec} />
                <Line value={owned.hdr == null ? null : owned.hdr ? (owned.hdrFormat ?? 'HDR') : 'SDR'} />
                <Line value={owned.audioCodec ? `${owned.audioCodec}${owned.audioChannels ? ` ${owned.audioChannels}ch` : ''}` : null} />
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{t('quality.noMeasurement')}</span>
            )}
          </QualityColumn>

          <QualityColumn label={t('quality.measured')}>
            {owned?.width && owned?.height ? <Line value={`${owned.width} × ${owned.height}`} /> : null}
            {owned?.bitrateKbps ? <Line value={`${formatNumber(owned.bitrateKbps)} kbps`} /> : null}
            {owned?.frameRate ? <Line value={`${owned.frameRate} fps`} /> : null}
            {owned?.sizeBytes ? <Line value={formatBytes(owned.sizeBytes)} /> : null}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('quality.probeCoverage', { measured: q.measuredFileCount, total: q.totalFileCount })}
            </p>
            {owned ? (
              <p className="text-[11px] text-muted-foreground">
                {t(`quality.provenance.${owned.provenance}` as 'quality.provenance.measured')}
              </p>
            ) : null}
          </QualityColumn>

          <QualityColumn label={t('quality.target')}>
            {top ? (
              <>
                <Line value={top.resolution} />
                <Line value={top.codec} />
                {top.requiredTerms.slice(0, 3).map((term) => (
                  <Line key={term} value={term} />
                ))}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </QualityColumn>

          <QualityColumn label={t('quality.preferenceSource')}>
            <Line value={c.preferenceSourceLabel} />
            {c.matchedRung != null ? (
              <p className="mt-1 text-xs">
                <span className="font-medium">{c.matchedRungName}</span>{' '}
                <span className="text-muted-foreground">
                  {t('quality.rungOf', { rung: c.matchedRung + 1, total: c.totalRungs })}
                </span>
              </p>
            ) : null}
          </QualityColumn>
        </div>

        {/* Per-dimension explanation: why this rung, and what could not be judged. */}
        {c.dimensions.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('quality.why')}</p>
            <div className="flex flex-wrap gap-2">
              {c.dimensions.slice(0, 10).map((d, i) => (
                <Badge key={`${d.dimension}-${i}`} variant={QUALITY_RESULT_VARIANT[d.result] ?? 'outline'}>
                  {t(`quality.dimension.${d.dimension}` as 'quality.dimension.resolution')}
                  {': '}
                  {t(`quality.result.${d.result}` as 'quality.result.pass')}
                  {d.reason ? ` — ${t(`quality.notEvaluableReason.${d.reason}` as 'quality.notEvaluableReason.not_measured')}` : ''}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {aggregate ? <QualityAggregate aggregate={aggregate} /> : null}

        <p className="text-[11px] text-muted-foreground">{t('quality.advisory')}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Per-episode roll-up for a series or season.
 *
 * Shows the outlier explicitly. "61 preferred, 1 below preference" is the
 * whole point — an aggregate that rounded that to "1080p series" would hide
 * the one episode the operator came here to find.
 */
function QualityAggregate({ aggregate }: { aggregate: NonNullable<MediaQualityFacts['aggregate']> }) {
  const { t } = useTranslation('mediaIntelligence');
  const rows: Array<[string, number, string]> = [
    [t('quality.aggregate.preferred'), aggregate.preferred, 'success'],
    [t('quality.aggregate.acceptable'), aggregate.acceptable, 'info'],
    [t('quality.aggregate.belowPreference'), aggregate.belowPreference, 'warning'],
    [t('quality.aggregate.unknown'), aggregate.unknown, 'outline'],
  ];

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {t('quality.aggregate.heading')}
      </p>
      <div className="flex flex-wrap gap-2">
        {rows.map(([label, count, variant]) =>
          count > 0 ? (
            <Badge key={label} variant={variant as 'success'}>
              {label}: {formatNumber(count)}
            </Badge>
          ) : null,
        )}
        {aggregate.upgradePotential > 0 ? (
          <Badge variant="info">
            {t('quality.aggregate.upgradePotential')}: {formatNumber(aggregate.upgradePotential)}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
        {aggregate.dominantResolution ? (
          <span>{t('quality.aggregate.dominant', { resolution: aggregate.dominantResolution })}</span>
        ) : null}
        {/* Surfaced separately so a single bad episode cannot hide in the mean. */}
        {aggregate.mixed && aggregate.worstResolution ? (
          <span>{t('quality.aggregate.worst', { resolution: aggregate.worstResolution })}</span>
        ) : null}
        {aggregate.mixed ? <span>{t('quality.aggregate.mixed')}</span> : null}
      </div>
    </div>
  );
}

function QualityColumn({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 space-y-0.5">{children}</div>
    </div>
  );
}

/** One value line. An absent value is an em dash, never a fabricated zero. */
function Line({ value }: { value: string | null | undefined }) {
  return <p className="truncate text-sm">{value ?? '—'}</p>;
}

/** One fact section, addressed by domain name. */
function sectionOf(state: UnifiedMediaState, domain: MediaIntelligenceDomain): FactSection | undefined {
  return (state as unknown as Record<string, FactSection>)[domain];
}

interface FactSection {
  status?: 'known' | 'partial' | 'unknown';
  unknownReason?: string | null;
  observedAt?: string | null;
  source?: string;
  [key: string]: unknown;
}

/**
 * A domain's facts.
 *
 * An unknown section shows WHY it is unknown rather than rendering blanks — the
 * distinction between "measured and empty" and "never looked" is the whole
 * point of the unknown-reason vocabulary, and collapsing it into an empty cell
 * would throw away the only thing that tells an operator what to do next.
 */
function DomainCard({ domain, section }: { domain: MediaIntelligenceDomain; section?: FactSection }) {
  const { t } = useTranslation('mediaIntelligence');
  const status = section?.status ?? 'unknown';
  const reason = section?.unknownReason;

  /*
   * Humanized rather than dumped. `Object.entries` gave "measuredFileCount /
   * 62" and "posterPresent / true", which is a debug view: the envelope keys
   * are rendered separately above, so they are omitted here.
   */
  const fields = humanizeFields(section, ['status', 'unknownReason', 'observedAt', 'source']);

  return (
    <Card>
      <CardContent className="space-y-2 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{t(`domain.${domain}` as 'domain.identity')}</span>
          <Badge variant={FACT_STATUS_VARIANT[status]}>
            {t(`factStatus.${status}` as 'factStatus.known')}
          </Badge>
        </div>

        {status === 'unknown' && reason ? (
          <p className="text-xs text-muted-foreground">
            {t('detail.unknownBecause', {
              reason: t(`unknownReason.${reason}` as 'unknownReason.not_probed'),
            })}
          </p>
        ) : null}

        {fields.length > 0 ? (
          <dl className="space-y-1">
            {fields.slice(0, 8).map((f) => (
              <div key={f.label} className="flex items-baseline justify-between gap-2 text-xs">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className={f.mono ? 'truncate font-mono text-[11px]' : 'tabular-nums'}>
                  {f.value ?? '—'}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {section?.observedAt ? (
          <p className="text-[11px] text-muted-foreground" title={formatDateTime(section.observedAt)}>
            {formatRelativeTimeShort(section.observedAt)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FindingRow({ finding }: { finding: MediaFinding }) {
  const { t } = useTranslation('mediaIntelligence');
  const evidence = humanizeFields(finding.evidence).slice(0, 6);

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={SEVERITY_VARIANT[finding.severity]}>
          {t(`severity.${finding.severity}` as 'severity.info')}
        </Badge>
        <span className="text-sm font-medium">
          {t(`finding.${finding.code}` as 'finding.EPISODES_MISSING')}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(`domain.${finding.domain}` as 'domain.identity')}
        </span>
      </div>

      {evidence.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {evidence.map((f) => (
            <span key={f.label} className="text-xs text-muted-foreground">
              {f.label}:{' '}
              <span className={f.mono ? 'font-mono text-[11px] text-foreground' : 'tabular-nums text-foreground'}>
                {f.value ?? '—'}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
        {finding.firstObservedAt ? (
          <span>{t('detail.since', { when: formatDateTime(finding.firstObservedAt) })}</span>
        ) : null}
        {finding.lastObservedAt ? (
          <span>{t('detail.lastSeen', { when: formatDateTime(finding.lastObservedAt) })}</span>
        ) : null}
      </div>
    </div>
  );
}
