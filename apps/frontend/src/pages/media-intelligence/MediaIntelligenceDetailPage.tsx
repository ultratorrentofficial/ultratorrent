import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import {
  MEDIA_INTELLIGENCE_DOMAINS,
  type MediaFinding,
  type MediaIntelligenceDomain,
  type MediaIntelligenceEntityType,
  type UnifiedMediaState,
} from '@ultratorrent/shared';

import { ApiError, api, type MediaArtwork, type MediaItemDetail, type ShowDetail } from '@/lib/api';
import { formatDateTime, formatRelativeTimeShort } from '@/lib/format';
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
