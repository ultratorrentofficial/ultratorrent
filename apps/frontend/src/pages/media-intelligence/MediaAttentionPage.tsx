import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MEDIA_ATTENTION_VIEWS,
  MEDIA_FINDING_SEVERITIES,
  MEDIA_INTELLIGENCE_DOMAINS,
  type MediaAttentionGroup,
  type MediaAttentionItem,
  type MediaAttentionView,
} from '@ultratorrent/shared';

import { ChevronRight } from 'lucide-react';

import { ApiError, api, type DispositionResult } from '@/lib/api';
import { formatDateTime, formatNumber, formatRelativeTimeShort } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { FindingDetailDrawer } from './FindingDetailDrawer';
import { SEVERITY_VARIANT } from './mediaIntelligenceUi';

const PAGE_SIZE = 50;
/** Grouped mode pages on titles, each of which expands into several rows. */
const GROUP_PAGE_SIZE = 25;

/** Snooze offsets, resolved against the browser clock into an absolute instant. */
const SNOOZE_OPTIONS = [
  { key: 'day', days: 1 },
  { key: 'threeDays', days: 3 },
  { key: 'week', days: 7 },
  { key: 'month', days: 30 },
] as const;

/**
 * The Attention Center — an operational inbox for the media lifecycle.
 *
 * Reads persisted conclusions and nothing else: opening this page starts no
 * scan, no probe, no provider call and no rebuild.
 *
 * The distinction the whole screen rests on: acknowledging, snoozing and
 * dismissing record what a PERSON decided. None of them changes whether the
 * finding is true, and the page says so rather than letting an operator infer
 * that dismissing a problem fixed it.
 */
export function MediaAttentionPage() {
  const { t } = useTranslation('mediaIntelligence');
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [view, setView] = useState<MediaAttentionView>('active');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState('');
  const [domain, setDomain] = useState('');
  const [escalatedOnly, setEscalatedOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [grouped, setGrouped] = useState(false);
  /** The finding open in the detail panel, or null. */
  const [detail, setDetail] = useState<MediaAttentionItem | null>(null);

  const summary = useQuery({
    queryKey: ['mediaIntelligence', 'attention', 'summary'],
    queryFn: () => api.mediaIntelligence.attentionSummary(),
  });

  /*
   * One filter object for both shapes. Filtering is server-side in either
   * case: narrowing a paginated list in the browser would filter one page and
   * silently hide every other match.
   */
  const filters = {
    view,
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(severity ? { severity } : {}),
    ...(domain ? { domain } : {}),
    ...(escalatedOnly ? { escalated: 'true' } : {}),
  };
  const filterKey = { view, q, severity, domain, escalatedOnly };

  const list = useQuery({
    queryKey: ['mediaIntelligence', 'attention', 'flat', { page, ...filterKey }],
    queryFn: () =>
      api.mediaIntelligence.attention({ ...filters, page: String(page), pageSize: String(PAGE_SIZE) }),
    placeholderData: keepPreviousData,
    enabled: !grouped,
  });

  const groups = useQuery({
    queryKey: ['mediaIntelligence', 'attention', 'grouped', { page, ...filterKey }],
    queryFn: () =>
      api.mediaIntelligence.attentionGrouped({
        ...filters,
        page: String(page),
        pageSize: String(GROUP_PAGE_SIZE),
      }),
    placeholderData: keepPreviousData,
    enabled: grouped,
  });

  const active = grouped ? groups : list;
  const groupRows = groups.data?.groups ?? [];
  const rows = list.data?.items ?? [];
  /*
   * Every finding currently on screen, whichever shape is showing. Grouped
   * mode must feed the same pruning as the flat list, or a bulk action could
   * still reach a row the operator can no longer see.
   */
  const onScreen = grouped ? groupRows.flatMap((g) => g.findings) : rows;
  const isEmpty = grouped ? groupRows.length === 0 : rows.length === 0;

  /**
   * Selection is pruned to what is actually on screen.
   *
   * A row that scrolled out of the result set after a filter change must not
   * stay silently actionable — bulk-dismissing something the operator can no
   * longer see is exactly the accident this avoids.
   */
  const visibleIds = useMemo(() => new Set(onScreen.map((r) => r.id)), [onScreen]);
  const effectiveSelection = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
    setSelected(new Set());
  };

  /**
   * Keep the open panel honest after a mutation.
   *
   * The drawer holds a snapshot of the row it was opened from; once the list
   * is refetched that snapshot is stale, so it closes rather than continuing
   * to show a disposition that has since changed.
   */
  const report = (result: DispositionResult) => {
    const parts = [t('attention.result.applied', { count: result.applied })];
    if (result.skippedResolved.length) {
      parts.push(t('attention.result.skippedResolved', { count: result.skippedResolved.length }));
    }
    if (result.unknown.length) {
      parts.push(t('attention.result.unknown', { count: result.unknown.length }));
    }
    toast.success(parts.join(' · '));
    setSelected(new Set());
    setDetail(null);
    void queryClient.invalidateQueries({ queryKey: ['mediaIntelligence', 'attention'] });
  };

  const disposition = useMutation({
    mutationFn: (input: { verb: 'acknowledge' | 'dismiss' | 'reset' | 'snooze'; ids: string[]; until?: string }) => {
      const { verb, ids, until } = input;
      if (ids.length === 1) {
        const id = ids[0];
        if (verb === 'acknowledge') return api.mediaIntelligence.acknowledgeFinding(id);
        if (verb === 'dismiss') return api.mediaIntelligence.dismissFinding(id);
        if (verb === 'reset') return api.mediaIntelligence.resetFinding(id);
        return api.mediaIntelligence.snoozeFinding(id, until!);
      }
      if (verb === 'acknowledge') return api.mediaIntelligence.bulkAcknowledgeFindings(ids);
      if (verb === 'dismiss') return api.mediaIntelligence.bulkDismissFindings(ids);
      // Reset has no bulk route: returning things to the queue is rare and
      // deliberate, so it stays a per-row act rather than a mass undo.
      if (verb === 'reset') return api.mediaIntelligence.resetFinding(ids[0]);
      return api.mediaIntelligence.bulkSnoozeFindings(ids, until!);
    },
    onSuccess: report,
    onError: (err) =>
      toast.error(t('attention.result.failed'), err instanceof ApiError ? err.message : undefined),
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openMedia = (row: { entityType: string; entityId: string }) =>
    navigate(`/media/intelligence/${row.entityType}/${row.entityId}`);

  const severityOptions = useMemo(
    () => [
      { value: '', label: t('attention.filters.allSeverities') },
      ...MEDIA_FINDING_SEVERITIES.map((s) => ({ value: s, label: t(`severity.${s}` as 'severity.info') })),
    ],
    [t],
  );
  const domainOptions = useMemo(
    () => [
      { value: '', label: t('attention.filters.allDomains') },
      ...MEDIA_INTELLIGENCE_DOMAINS.map((d) => ({ value: d, label: t(`domain.${d}` as 'domain.identity') })),
    ],
    [t],
  );

  const s = summary.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('attention.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('attention.subtitle')}</p>
      </div>

      {/* Stated once, plainly: a decision is not a fix. */}
      <p className="text-xs text-muted-foreground">{t('attention.advisory')}</p>

      {s ? (
        <div data-testid="attention-summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label={t('attention.summary.active')} value={s.active} />
          <Tile label={t('attention.summary.critical')} value={s.critical} variant="destructive" />
          <Tile label={t('attention.summary.warning')} value={s.warning} variant="warning" />
          <Tile label={t('attention.summary.escalated')} value={s.escalated} variant="info" />
          <Tile label={t('attention.summary.snoozed')} value={s.snoozed} />
          <Tile label={t('attention.summary.dismissed')} value={s.dismissed} />
        </div>
      ) : null}

      <Tabs value={view} onValueChange={(v) => reset(setView)(v as MediaAttentionView)}>
        <TabsList>
          {MEDIA_ATTENTION_VIEWS.map((v) => (
            <TabsTrigger key={v} value={v}>
              {t(`attention.views.${v}` as 'attention.views.active')}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              placeholder={t('attention.filters.search')}
              value={q}
              onChange={(e) => reset(setQ)(e.target.value)}
            />
            <Select options={severityOptions} value={severity} onChange={(e) => reset(setSeverity)(e.target.value)} />
            <Select options={domainOptions} value={domain} onChange={(e) => reset(setDomain)(e.target.value)} />
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={escalatedOnly}
                  onChange={(e) => reset(setEscalatedOnly)(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input"
                />
                {t('attention.filters.escalatedOnly')}
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={grouped}
                  onChange={(e) => reset(setGrouped)(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input"
                />
                {t('attention.groupByMedia')}
              </label>
            </div>
          </div>

          {effectiveSelection.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
              <span className="text-xs text-muted-foreground">
                {t('attention.actions.selected', { count: effectiveSelection.length })}
              </span>
              <Button
                size="sm"
                variant="outline"
                loading={disposition.isPending}
                onClick={() => disposition.mutate({ verb: 'acknowledge', ids: effectiveSelection })}
              >
                {t('attention.actions.acknowledge')}
              </Button>
              <SnoozeMenu
                disabled={disposition.isPending}
                onPick={(until) => disposition.mutate({ verb: 'snooze', ids: effectiveSelection, until })}
              />
              <Button
                size="sm"
                variant="outline"
                loading={disposition.isPending}
                onClick={() => disposition.mutate({ verb: 'dismiss', ids: effectiveSelection })}
              >
                {t('attention.actions.dismiss')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                {t('attention.actions.clearSelection')}
              </Button>
            </div>
          ) : null}

          {active.isLoading ? (
            <CenteredSpinner label={t('attention.title')} />
          ) : active.isError ? (
            <ErrorState
              title={t('attention.result.failed')}
              message={active.error instanceof ApiError ? active.error.message : undefined}
              onRetry={() => {
                void active.refetch();
              }}
            />
          ) : isEmpty ? (
            <EmptyState
              title={
                q || severity || domain || escalatedOnly
                  ? t('attention.empty.filtered')
                  : t(`attention.empty.${view}` as 'attention.empty.active')
              }
              // Never imply the whole library is healthy just because this
              // filter is empty.
              description={q || severity || domain || escalatedOnly ? t('attention.empty.hint') : undefined}
            />
          ) : (
            <>
              <div data-testid="attention-rows" className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>{t('attention.columns.media')}</TableHead>
                      <TableHead>{t('attention.columns.finding')}</TableHead>
                      <TableHead>{t('attention.columns.severity')}</TableHead>
                      <TableHead>{t('attention.columns.state')}</TableHead>
                      <TableHead>{t('attention.columns.firstSeen')}</TableHead>
                      <TableHead className="text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grouped
                      ? groupRows.map((group) => (
                          <GroupRows
                            key={`${group.entityType}:${group.entityId}`}
                            group={group}
                            selected={selected}
                            busy={disposition.isPending}
                            onToggle={toggle}
                            onOpenMedia={openMedia}
                            onReview={setDetail}
                            onVerb={(id, verb, until) => disposition.mutate({ verb, ids: [id], until })}
                          />
                        ))
                      : rows.map((row) => (
                          <AttentionRow
                            key={row.id}
                            row={row}
                            checked={selected.has(row.id)}
                            busy={disposition.isPending}
                            onToggle={() => toggle(row.id)}
                            onOpenMedia={() => openMedia(row)}
                            onReview={() => setDetail(row)}
                            onVerb={(verb, until) => disposition.mutate({ verb, ids: [row.id], until })}
                          />
                        ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                page={page}
                // Grouped mode pages on TITLES, so both numbers must describe
                // titles or the control would promise pages that don't exist.
                pageSize={grouped ? GROUP_PAGE_SIZE : PAGE_SIZE}
                total={(grouped ? groups.data?.total : list.data?.total) ?? 0}
                onPage={setPage}
                busy={active.isFetching}
              />
            </>
          )}
        </CardContent>
      </Card>

      <FindingDetailDrawer
        finding={detail}
        busy={disposition.isPending}
        onClose={() => setDetail(null)}
        onOpenMedia={() => {
          if (detail) openMedia(detail);
        }}
        onVerb={(verb, until) => {
          if (detail) disposition.mutate({ verb, ids: [detail.id], until });
        }}
      />
    </div>
  );
}

/**
 * One title and its findings.
 *
 * Collapsed by default and expanded on demand, mirroring the grouped series
 * list elsewhere. The card carries the WORST severity it contains — computed
 * server-side — so a critical finding can never hide behind a parent that
 * reads "warning".
 */
function GroupRows({
  group,
  selected,
  busy,
  onToggle,
  onOpenMedia,
  onReview,
  onVerb,
}: {
  group: MediaAttentionGroup;
  selected: Set<string>;
  busy: boolean;
  onToggle: (id: string) => void;
  onOpenMedia: (row: { entityType: string; entityId: string }) => void;
  onReview: (row: MediaAttentionItem) => void;
  onVerb: (id: string, verb: 'acknowledge' | 'dismiss' | 'reset' | 'snooze', until?: string) => void;
}) {
  const { t } = useTranslation('mediaIntelligence');
  const [open, setOpen] = useState(false);

  return (
    <>
      <TableRow className="bg-muted/30">
        <TableCell>
          <button
            type="button"
            aria-expanded={open}
            aria-label={group.title}
            onClick={() => setOpen((v) => !v)}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-muted"
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        </TableCell>
        <TableCell>
          <button
            type="button"
            className="text-left font-medium hover:underline"
            onClick={() => onOpenMedia(group)}
          >
            {group.title}
          </button>
          {group.year ? <span className="ml-1 text-muted-foreground">({group.year})</span> : null}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {t('attention.findingsHere', { count: group.findingCount })}
        </TableCell>
        <TableCell>
          <Badge variant={SEVERITY_VARIANT[group.severity as 'warning'] ?? 'outline'} dot>
            {t(`severity.${group.severity}` as 'severity.info')}
          </Badge>
        </TableCell>
        <TableCell>
          {group.escalated ? <Badge variant="info">{t('attention.escalation.badge')}</Badge> : null}
        </TableCell>
        <TableCell colSpan={2} />
      </TableRow>
      {open
        ? group.findings.map((row) => (
            <AttentionRow
              key={row.id}
              row={row}
              nested
              checked={selected.has(row.id)}
              busy={busy}
              onToggle={() => onToggle(row.id)}
              onOpenMedia={() => onOpenMedia(row)}
              onReview={() => onReview(row)}
              onVerb={(verb, until) => onVerb(row.id, verb, until)}
            />
          ))
        : null}
    </>
  );
}

function AttentionRow({
  row,
  checked,
  busy,
  nested,
  onToggle,
  onOpenMedia,
  onReview,
  onVerb,
}: {
  row: MediaAttentionItem;
  checked: boolean;
  busy: boolean;
  /** Rendered underneath a group card; indented to show what it belongs to. */
  nested?: boolean;
  onToggle: () => void;
  onOpenMedia: () => void;
  onReview: () => void;
  onVerb: (verb: 'acknowledge' | 'dismiss' | 'reset' | 'snooze', until?: string) => void;
}) {
  const { t } = useTranslation('mediaIntelligence');

  return (
    <TableRow>
      <TableCell>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={t('attention.actions.selected', { count: 1 })}
          className="h-3.5 w-3.5 rounded border-input"
        />
      </TableCell>
      <TableCell className={nested ? 'pl-8' : undefined}>
        <button type="button" className="text-left font-medium hover:underline" onClick={onOpenMedia}>
          {row.title}
        </button>
        {row.year ? <span className="ml-1 text-muted-foreground">({row.year})</span> : null}
      </TableCell>
      <TableCell>
        <span className="text-sm">{t(`finding.${row.code}` as 'finding.EPISODES_MISSING')}</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {t(`domain.${row.domain}` as 'domain.identity')}
        </span>
      </TableCell>
      <TableCell>
        {/* Severity carries a label as well as a colour: colour alone is not
            an accessible signal. */}
        <Badge variant={SEVERITY_VARIANT[row.severity as 'warning'] ?? 'outline'} dot>
          {t(`severity.${row.severity}` as 'severity.info')}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="outline">
            {t(`attention.disposition.${row.disposition}` as 'attention.disposition.unreviewed')}
          </Badge>
          {row.escalated ? <Badge variant="info">{t('attention.escalation.badge')}</Badge> : null}
          {row.snoozedUntil ? (
            <span className="text-[11px] text-muted-foreground">
              {t('attention.snooze.until', { when: formatDateTime(row.snoozedUntil) })}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground" title={formatDateTime(row.firstObservedAt)}>
        {formatRelativeTimeShort(row.firstObservedAt)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {/* Review opens the detail panel; the title opens the media page. */}
          <Button size="sm" variant="ghost" onClick={onReview}>
            {t('attention.actions.review')}
          </Button>
          {row.disposition === 'unreviewed' || row.disposition === 'acknowledged' ? (
            <>
              {row.disposition === 'unreviewed' ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onVerb('acknowledge')}>
                  {t('attention.actions.acknowledge')}
                </Button>
              ) : null}
              <SnoozeMenu disabled={busy} onPick={(until) => onVerb('snooze', until)} />
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onVerb('dismiss')}>
                {t('attention.actions.dismiss')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onVerb('reset')}>
              {t('attention.actions.reset')}
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Snooze durations.
 *
 * A native `<select>` so the control is keyboard-operable for free. The
 * offset is resolved to an absolute instant here — the server stores the
 * instant, never "next week", so the meaning cannot depend on who reads the
 * row or when.
 */
function SnoozeMenu({ disabled, onPick }: { disabled: boolean; onPick: (untilIso: string) => void }) {
  const { t } = useTranslation('mediaIntelligence');
  return (
    <Select
      aria-label={t('attention.actions.snooze')}
      disabled={disabled}
      value=""
      className="h-8 w-auto text-xs"
      onChange={(e) => {
        const opt = SNOOZE_OPTIONS.find((o) => o.key === e.target.value);
        if (!opt) return;
        onPick(new Date(Date.now() + opt.days * 86_400_000).toISOString());
        e.target.value = '';
      }}
      options={[
        { value: '', label: t('attention.actions.snooze') },
        ...SNOOZE_OPTIONS.map((o) => ({
          value: o.key,
          label: t(`attention.snooze.${o.key}` as 'attention.snooze.day'),
        })),
      ]}
    />
  );
}

function Tile({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant?: 'destructive' | 'warning' | 'info';
}) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-xl font-semibold tabular-nums">{formatNumber(value)}</span>
          {variant && value > 0 ? <Badge variant={variant} dot /> : null}
        </div>
      </CardContent>
    </Card>
  );
}
