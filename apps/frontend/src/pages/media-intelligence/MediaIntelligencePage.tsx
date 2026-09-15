import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  MEDIA_FINDING_SEVERITIES,
  MEDIA_HEALTH_STATUSES,
  MEDIA_INTELLIGENCE_DOMAINS,
  MEDIA_INTELLIGENCE_ENTITY_TYPES,
  MEDIA_QUALITY_STATUSES,
  type MediaFindingSeverity,
  type MediaHealthStatus,
  type MediaIntelligenceSummary,
} from '@ultratorrent/shared';

import { ApiError, api } from '@/lib/api';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTimeShort } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import {
  HEALTH_ORDER,
  HEALTH_VARIANT,
  QUALITY_VARIANT,
  SEVERITY_ORDER,
  SEVERITY_VARIANT,
} from './mediaIntelligenceUi';

const PAGE_SIZE = 50;

/**
 * Media Intelligence — overview and the Media Health list.
 *
 * Overview and list share one screen because they answer one question at two
 * zoom levels ("how is the library doing" / "which titles specifically"), and
 * the counts are how an operator picks the filter for the list below them.
 *
 * Everything here is a read. The single write is `Rebuild`, which recomputes
 * the derived projection from facts the media domains already hold — it starts
 * no scan, no probe and no search, and the page says so rather than leaving an
 * operator to guess what a button labelled "rebuild" might touch.
 */
export function MediaIntelligencePage() {
  const { t } = useTranslation('mediaIntelligence');
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [entityType, setEntityType] = useState('');
  const [health, setHealth] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [severity, setSeverity] = useState('');
  const [domain, setDomain] = useState('');
  const [quality, setQuality] = useState('');
  const [upgradeOnly, setUpgradeOnly] = useState(false);

  const overview = useQuery({
    queryKey: ['mediaIntelligence', 'overview'],
    queryFn: () => api.mediaIntelligence.overview(),
  });

  const libraries = useQuery({
    queryKey: ['media', 'libraries'],
    queryFn: () => api.media.listLibraries(),
  });

  const list = useQuery({
    queryKey: ['mediaIntelligence', 'list', { page, q, entityType, health, libraryId, severity, domain, quality, upgradeOnly }],
    queryFn: () =>
      api.mediaIntelligence.list({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(entityType ? { entityType } : {}),
        ...(health ? { health } : {}),
        ...(libraryId ? { libraryId } : {}),
        ...(severity ? { severity } : {}),
        ...(domain ? { domain } : {}),
        ...(quality ? { quality } : {}),
        // Server-side: filtering a paginated list in the browser would narrow
        // one page of 50 and silently hide every other match.
        ...(upgradeOnly ? { upgradePotential: 'true' } : {}),
      }),
    placeholderData: keepPreviousData,
  });

  const rebuild = useMutation({
    mutationFn: () => api.mediaIntelligence.rebuild(),
    onSuccess: (summary) => {
      if (summary.skipped) {
        toast.info(t('overview.rebuildBusy'));
        return;
      }
      toast.success(
        t('overview.rebuildStarted'),
        t('overview.rebuildResult', {
          movies: summary.movies,
          series: summary.series,
          failed: summary.failed,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ['mediaIntelligence'] });
    },
    onError: (err) =>
      toast.error(t('overview.rebuildFailed'), err instanceof ApiError ? err.message : undefined),
  });

  /** Reset to the first page whenever a filter narrows the result set. */
  const withReset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const healthOptions = useMemo(
    () => [
      { value: '', label: t('list.filters.allHealth') },
      ...MEDIA_HEALTH_STATUSES.map((s) => ({ value: s, label: t(`health.${s}` as 'health.healthy') })),
    ],
    [t],
  );

  const typeOptions = useMemo(
    () => [
      { value: '', label: t('list.filters.allTypes') },
      ...MEDIA_INTELLIGENCE_ENTITY_TYPES.map((e) => ({
        value: e,
        label: t(`list.entityType.${e}` as 'list.entityType.movie'),
      })),
    ],
    [t],
  );

  const severityOptions = useMemo(
    () => [
      { value: '', label: t('list.filters.allSeverities') },
      ...MEDIA_FINDING_SEVERITIES.map((s) => ({ value: s, label: t(`severity.${s}` as 'severity.info') })),
    ],
    [t],
  );

  const domainOptions = useMemo(
    () => [
      { value: '', label: t('list.filters.allDomains') },
      ...MEDIA_INTELLIGENCE_DOMAINS.map((d) => ({ value: d, label: t(`domain.${d}` as 'domain.identity') })),
    ],
    [t],
  );

  const qualityOptions = useMemo(
    () => [
      { value: '', label: t('list.filters.allQuality') },
      ...MEDIA_QUALITY_STATUSES.map((s) => ({
        value: s,
        label: t(`quality.status.${s}` as 'quality.status.preferred'),
      })),
    ],
    [t],
  );

  const libraryOptions = useMemo(
    () => [
      { value: '', label: t('list.filters.allLibraries') },
      ...(libraries.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    ],
    [libraries.data, t],
  );

  const o = overview.data;
  const rows = list.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => rebuild.mutate()}
          loading={rebuild.isPending}
          disabled={o?.rebuilding}
        >
          <RefreshCw className="h-4 w-4" />
          {o?.rebuilding ? t('overview.rebuilding') : t('overview.rebuild')}
        </Button>
      </div>

      {/*
        Stated once, plainly, at the top. A page full of problems invites the
        assumption that something here will fix them.
      */}
      <p className="text-xs text-muted-foreground">{t('advisory')}</p>

      {o ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label={t('overview.analyzed')} value={formatNumber(o.analyzed)} />
          {HEALTH_ORDER.map((s) => (
            <StatTile
              key={s}
              label={t(`health.${s}` as 'health.healthy')}
              value={formatNumber(o.byHealth[s] ?? 0)}
              variant={HEALTH_VARIANT[s]}
              active={health === s}
              onClick={() => withReset(setHealth)(health === s ? '' : s)}
            />
          ))}
        </div>
      ) : null}

      {o && o.analyzed === 0 ? (
        <EmptyState title={t('overview.neverAnalyzed')} description={t('overview.neverAnalyzedBody')} />
      ) : null}

      {o && o.byFindingCode.length > 0 ? (
        <Card>
          <CardContent className="space-y-3 py-4">
            <h2 className="text-sm font-semibold">{t('overview.topFindings')}</h2>
            <div className="flex flex-wrap gap-2">
              {o.byFindingCode.slice(0, 12).map((f) => (
                <Badge key={f.code} variant={SEVERITY_VARIANT[f.severity]}>
                  {t(`finding.${f.code}` as 'finding.EPISODES_MISSING')} · {formatNumber(f.count)}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('overview.lastCalculated')}:{' '}
              {o.lastCalculatedAt ? formatDateTime(o.lastCalculatedAt) : t('overview.never')}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Input
              placeholder={t('list.search')}
              value={q}
              onChange={(e) => withReset(setQ)(e.target.value)}
              className="lg:col-span-2"
            />
            <Select options={typeOptions} value={entityType} onChange={(e) => withReset(setEntityType)(e.target.value)} />
            <Select options={healthOptions} value={health} onChange={(e) => withReset(setHealth)(e.target.value)} />
            <Select options={libraryOptions} value={libraryId} onChange={(e) => withReset(setLibraryId)(e.target.value)} />
            <Select options={severityOptions} value={severity} onChange={(e) => withReset(setSeverity)(e.target.value)} />
            <Select options={domainOptions} value={domain} onChange={(e) => withReset(setDomain)(e.target.value)} />
            <Select options={qualityOptions} value={quality} onChange={(e) => withReset(setQuality)(e.target.value)} />
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={upgradeOnly}
              onChange={(e) => withReset(setUpgradeOnly)(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-input"
            />
            {t('list.filters.upgradeOnly')}
          </label>

          {list.isLoading ? (
            <CenteredSpinner label={t('title')} />
          ) : list.isError ? (
            <ErrorState
              title={t('list.error')}
              message={list.error instanceof ApiError ? list.error.message : undefined}
              onRetry={() => void list.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState title={o && o.analyzed === 0 ? t('list.emptyUnanalyzed') : t('list.empty')} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('list.columns.title')}</TableHead>
                      <TableHead>{t('list.columns.health')}</TableHead>
                      <TableHead>{t('list.columns.quality')}</TableHead>
                      <TableHead>{t('list.columns.findings')}</TableHead>
                      <TableHead className="text-right">{t('list.columns.missing')}</TableHead>
                      <TableHead className="text-right">{t('list.columns.size')}</TableHead>
                      <TableHead>{t('list.columns.library')}</TableHead>
                      <TableHead>{t('list.columns.lastPlayed')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <IntelligenceRow
                        key={`${row.entityType}:${row.entityId}`}
                        row={row}
                        onOpen={() => navigate(`/media/intelligence/${row.entityType}/${row.entityId}`)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={list.data?.total ?? 0}
                onPage={setPage}
                busy={list.isFetching}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function IntelligenceRow({ row, onOpen }: { row: MediaIntelligenceSummary; onOpen: () => void }) {
  const { t } = useTranslation('mediaIntelligence');
  const counts = row.findingCounts;
  const present = SEVERITY_ORDER.filter((s) => (counts?.[s] ?? 0) > 0);

  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell>
        <span className="font-medium">{row.title}</span>
        {row.year ? <span className="ml-1 text-muted-foreground">({row.year})</span> : null}
        <span className="ml-2 text-xs text-muted-foreground">
          {t(`list.entityType.${row.entityType}` as 'list.entityType.movie')}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant={HEALTH_VARIANT[row.health as MediaHealthStatus]} dot>
          {t(`health.${row.health}` as 'health.healthy')}
        </Badge>
      </TableCell>
      <TableCell>
        {row.qualityStatus ? (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant={QUALITY_VARIANT[row.qualityStatus] ?? 'outline'}>
              {t(`quality.status.${row.qualityStatus}` as 'quality.status.preferred')}
            </Badge>
            {/* Potential, never availability — nothing has been searched for. */}
            {row.upgradePotential ? (
              <Badge variant="info" title={t('quality.advisory')}>
                {t('quality.upgradePotential')}
              </Badge>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {present.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {present.map((s) => (
              <Badge
                key={s}
                variant={SEVERITY_VARIANT[s as MediaFindingSeverity]}
                title={t(`severity.${s}` as 'severity.info')}
              >
                {formatNumber(counts[s])}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      {/* A null missing count is "not applicable", not zero — never render 0. */}
      <TableCell className="text-right tabular-nums">
        {row.missingCount == null ? '—' : formatNumber(row.missingCount)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.totalBytes == null ? '—' : formatBytes(row.totalBytes)}
      </TableCell>
      <TableCell className="text-muted-foreground">{row.libraryName ?? '—'}</TableCell>
      <TableCell className="text-muted-foreground" title={row.lastPlayedAt ? formatDateTime(row.lastPlayedAt) : undefined}>
        {row.lastPlayedAt ? formatRelativeTimeShort(row.lastPlayedAt) : t('list.never')}
      </TableCell>
    </TableRow>
  );
}

function StatTile({
  label,
  value,
  variant,
  active,
  onClick,
}: {
  label: string;
  value: string;
  variant?: 'success' | 'warning' | 'destructive' | 'outline' | 'info' | 'secondary' | 'default';
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <CardContent className="py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-xl font-semibold tabular-nums">{value}</span>
        {variant ? <Badge variant={variant} dot /> : null}
      </div>
    </CardContent>
  );
  if (!onClick) return <Card>{body}</Card>;
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={`cursor-pointer transition-colors hover:border-primary/40 ${active ? 'border-primary' : ''}`}
    >
      {body}
    </Card>
  );
}
