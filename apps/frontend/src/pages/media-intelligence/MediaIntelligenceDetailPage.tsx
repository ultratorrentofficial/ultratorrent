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

import { ApiError, api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
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
              {t('detail.assembledAt', { when: formatDate(s.freshness.assembledAt) })}
            </span>
          </div>
        </div>
        <Button variant="secondary" onClick={() => refresh.mutate()} loading={refresh.isPending}>
          <RefreshCw className="h-4 w-4" /> {t('detail.refresh')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t('advisory')}</p>

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

  const entries = Object.entries(section ?? {}).filter(
    ([k, v]) =>
      !['status', 'unknownReason', 'observedAt', 'source'].includes(k) &&
      v !== null &&
      v !== undefined &&
      typeof v !== 'object',
  );

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

        {entries.length > 0 ? (
          <dl className="space-y-1">
            {entries.slice(0, 8).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2 text-xs">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="tabular-nums">{String(v)}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {section?.observedAt ? (
          <p className="text-[11px] text-muted-foreground">{formatDate(section.observedAt)}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FindingRow({ finding }: { finding: MediaFinding }) {
  const { t } = useTranslation('mediaIntelligence');
  const evidence = Object.entries(finding.evidence ?? {}).slice(0, 6);

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
          {evidence.map(([k, v]) => (
            <span key={k} className="text-xs text-muted-foreground">
              {k}: <span className="tabular-nums text-foreground">{formatEvidence(v)}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
        {finding.firstObservedAt ? (
          <span>{t('detail.since', { when: formatDate(finding.firstObservedAt) })}</span>
        ) : null}
        {finding.lastObservedAt ? (
          <span>{t('detail.lastSeen', { when: formatDate(finding.lastObservedAt) })}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Evidence is bounded and machine-shaped; render arrays as a short list. */
function formatEvidence(value: unknown): string {
  if (Array.isArray(value)) return value.slice(0, 5).map(String).join(', ');
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 80);
  return String(value);
}
