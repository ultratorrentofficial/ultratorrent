import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleDot,
  CircleX,
  Download,
  DownloadCloud,
  FlaskConical,
  Gavel,
  History,
  ListChecks,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  ScrollText,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  Trash2,
  X,
} from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  ApiError,
  api,
  type AcquisitionEvaluation,
  type AcquisitionEvaluationDetail,
  type AcquisitionMediaType,
  type AcquisitionProfile,
  type AcquisitionSettings,
  type AcquisitionTraceStep,
  type CreateAcquisitionProfileInput,
  type CreateWatchlistInput,
  type MediaAcquisitionDecision,
  type WatchlistItem,
  type WatchlistItemType,
} from '@/lib/api';
import { formatDateTime, formatNumber, formatPercent } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { AddSeriesFromLibraryDialog } from './AddSeriesFromLibraryDialog';
import { AutoDownloadPreferencesTab } from './AutoDownloadPreferencesTab';
import { cn } from '@/lib/utils';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

const QK = ['media-acquisition'] as const;

const WATCHLIST_TYPE_VALUES: WatchlistItemType[] = [
  'series',
  'season',
  'episode',
  'movie',
  'movie_collection',
  'anime',
  'manual_query',
];

const MEDIA_TYPE_VALUES: AcquisitionMediaType[] = ['any', 'tv', 'movie', 'anime'];

// Technical resolution/source/codec tokens rendered verbatim; only the leading
// "Any" option is translated (see buildTechnicalOptions callers).
const RESOLUTION_VALUES = ['2160p (4K)', '1080p', '720p', '480p'];
const SOURCE_VALUES = ['BluRay', 'WEB-DL', 'WEBRip', 'HDTV'];
const CODEC_VALUES: { value: string; label: string }[] = [
  { value: 'x265', label: 'x265 / HEVC' },
  { value: 'x264', label: 'x264 / AVC' },
  { value: 'AV1', label: 'AV1' },
];

const OVERRIDE_DECISION_VALUES: MediaAcquisitionDecision[] = [
  'download',
  'skip',
  'hold_for_approval',
  'upgrade_existing',
  'replace_existing',
  'manual_review',
];

const DECISION_META: Record<string, { variant: BadgeVariant; className?: string }> = {
  download: { variant: 'success' },
  skip: { variant: 'secondary' },
  hold_for_approval: { variant: 'warning' },
  upgrade_existing: { variant: 'info' },
  replace_existing: { variant: 'outline', className: 'bg-info/10 text-info border-info/30' },
  manual_review: {
    variant: 'outline',
    className: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  },
};

function DecisionBadge({ decision }: { decision: string }) {
  const { t } = useTranslation('media');
  const m = DECISION_META[decision] ?? { variant: 'outline' as BadgeVariant };
  const labels: Record<string, string> = {
    download: t('acquisition.decision.download'),
    skip: t('acquisition.decision.skip'),
    hold_for_approval: t('acquisition.decision.hold_for_approval'),
    upgrade_existing: t('acquisition.decision.upgrade_existing'),
    replace_existing: t('acquisition.decision.replace_existing'),
    manual_review: t('acquisition.decision.manual_review'),
  };
  return (
    <Badge variant={m.variant} className={m.className}>
      {labels[decision] ?? decision}
    </Badge>
  );
}

function approvalVariant(status: string): BadgeVariant {
  switch (status) {
    case 'approved':
      return 'success';
    case 'rejected':
      return 'destructive';
    case 'pending':
      return 'warning';
    default:
      return 'secondary';
  }
}

/**
 * An evaluation's `releaseScore` is a breakdown object ({value, reasons, …}),
 * not a bare number — rendering it directly throws React #31. Read the numeric
 * `value` (tolerating a plain number for safety).
 */
export function scoreValue(s: AcquisitionEvaluation['releaseScore'] | null | undefined): number | string {
  if (s == null) return '—';
  if (typeof s === 'number') return s;
  return s.value ?? '—';
}

function renderMeta(value: unknown, yes: string, no: string): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? yes : no;
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function MediaAcquisitionPage() {
  const { t } = useTranslation('media');
  const [tab, setTab] = useState('overview');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Sparkles className="h-6 w-6 text-primary" /> {t('acquisition.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('acquisition.subtitle')}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto scrollbar-thin">
          <TabsList>
            <TabsTrigger value="overview">{t('acquisition.tabs.overview')}</TabsTrigger>
            <TabsTrigger value="watchlist">{t('acquisition.tabs.watchlist')}</TabsTrigger>
            <TabsTrigger value="profiles">{t('acquisition.tabs.profiles')}</TabsTrigger>
            <TabsTrigger value="auto-download">{t('acquisition.tabs.autoDownload')}</TabsTrigger>
            <TabsTrigger value="evaluations">{t('acquisition.tabs.evaluations')}</TabsTrigger>
            <TabsTrigger value="approvals">{t('acquisition.tabs.approvals')}</TabsTrigger>
            <TabsTrigger value="recommendations">{t('acquisition.tabs.recommendations')}</TabsTrigger>
            <TabsTrigger value="history">{t('acquisition.tabs.history')}</TabsTrigger>
            <TabsTrigger value="settings">{t('acquisition.tabs.settings')}</TabsTrigger>
          </TabsList>
        </div>

        <div className="mt-4">
          <TabsContent value="overview">
            <OverviewTab />
          </TabsContent>
          <TabsContent value="watchlist">
            <WatchlistTab />
          </TabsContent>
          <TabsContent value="profiles">
            <ProfilesTab />
          </TabsContent>
          <TabsContent value="auto-download">
            <AutoDownloadPreferencesTab />
          </TabsContent>
          <TabsContent value="evaluations">
            <EvaluationsTab />
          </TabsContent>
          <TabsContent value="approvals">
            <ApprovalQueueTab />
          </TabsContent>
          <TabsContent value="recommendations">
            <RecommendationsTab />
          </TabsContent>
          <TabsContent value="history">
            <HistoryTab />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'destructive' | 'info' | 'muted';
}

const toneText: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  info: 'text-info',
  muted: 'text-muted-foreground',
};

function StatCard({ icon, label, value, tone = 'default' }: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/5">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className={cn('text-xl font-bold tabular-nums leading-tight', toneText[tone])}>
            {value}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function StepIcon({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (['pass', 'passed', 'ok', 'success', 'matched'].includes(s))
    return <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />;
  if (['fail', 'failed', 'error', 'blocked', 'rejected'].includes(s))
    return <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />;
  return <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}

function TraceView({ steps }: { steps: AcquisitionTraceStep[] }) {
  const { t } = useTranslation('media');
  if (!steps || steps.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('acquisition.trace.empty')}</p>;
  }
  return (
    <ol className="space-y-2">
      {steps.map((step, i) => (
        <li
          key={`${step.step}-${i}`}
          className="flex items-start gap-2.5 rounded-md border border-border/60 bg-white/[0.02] px-3 py-2"
        >
          <StepIcon status={step.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium capitalize">
                {step.step.replace(/_/g, ' ')}
              </span>
              <Badge variant="outline" className="capitalize">
                {step.status}
              </Badge>
              {typeof step.score === 'number' && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('acquisition.trace.score', { score: step.score })}
                </span>
              )}
              {step.decision && <DecisionBadge decision={step.decision} />}
            </div>
            {step.reason && (
              <p className="mt-0.5 text-xs text-muted-foreground">{step.reason}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Chip / tag editor backed by a string array. */
function ChipInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation('media');
  const [draft, setDraft] = useState('');
  const commit = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex min-h-[40px] flex-wrap items-center gap-1.5 rounded-md border border-input bg-white/[0.02] p-2">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={t('acquisition.common.removeName', { name: v })}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={values.length ? '' : placeholder}
          className="min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab() {
  const { t } = useTranslation('media');
  const overviewQuery = useQuery({
    queryKey: [...QK, 'overview'],
    queryFn: api.mediaAcquisition.overview,
    refetchInterval: 15_000,
  });

  if (overviewQuery.isLoading) return <CenteredSpinner label={t('acquisition.overview.loading')} />;
  if (overviewQuery.isError)
    return (
      <ErrorState
        message={t('acquisition.overview.error')}
        onRetry={() => overviewQuery.refetch()}
      />
    );

  const data = overviewQuery.data;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard
          icon={<ListChecks className="h-5 w-5" />}
          label={t('acquisition.overview.stats.activeWatchlist')}
          value={formatNumber(data.watchlist.active)}
        />
        <StatCard
          icon={<Gavel className="h-5 w-5" />}
          label={t('acquisition.overview.stats.pendingApprovals')}
          value={formatNumber(data.approvals.pending)}
          tone="warning"
        />
        <StatCard
          icon={<DownloadCloud className="h-5 w-5" />}
          label={t('acquisition.overview.stats.downloadsRecommended')}
          value={formatNumber(data.decisions.recommended)}
          tone="success"
        />
        <StatCard
          icon={<CircleDot className="h-5 w-5" />}
          label={t('acquisition.overview.stats.skipped')}
          value={formatNumber(data.decisions.skipped)}
          tone="muted"
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label={t('acquisition.overview.stats.upgrades')}
          value={formatNumber(data.decisions.upgrades)}
          tone="info"
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {t('acquisition.overview.recentDecisions')}
        </h2>
        <Card>
          <CardContent className="p-0">
            {data.recent.length === 0 ? (
              <EmptyState
                icon={<Sparkles className="h-6 w-6" />}
                title={t('acquisition.overview.emptyTitle')}
                description={t('acquisition.overview.emptyBody')}
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {data.recent.map((d) => (
                  <li key={d.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm" title={d.releaseName}>
                        {d.releaseName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {d.reason} · {formatDateTime(d.createdAt)}
                      </p>
                    </div>
                    <DecisionBadge decision={d.decision} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watchlist tab
// ---------------------------------------------------------------------------

function WatchlistTab() {
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_MANAGE_WATCHLIST);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [editing, setEditing] = useState<WatchlistItem | null>(null);

  const watchlistQuery = useQuery({
    queryKey: [...QK, 'watchlist', statusFilter],
    queryFn: () => api.mediaAcquisition.watchlist(statusFilter || undefined),
  });

  const profilesQuery = useQuery({
    queryKey: [...QK, 'profiles', 'all'],
    queryFn: () => api.mediaAcquisition.profiles(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [...QK, 'watchlist'] });
    queryClient.invalidateQueries({ queryKey: [...QK, 'overview'] });
  };

  const toggleMutation = useMutation({
    mutationFn: (item: WatchlistItem) =>
      api.mediaAcquisition.updateWatchlist(item.id, {
        status: item.status === 'paused' ? 'active' : 'paused',
      }),
    onSuccess: () => {
      toast.success(t('acquisition.watchlist.toast.updated'));
      invalidate();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.watchlist.toast.updateFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.mediaAcquisition.deleteWatchlist(id),
    onSuccess: () => {
      toast.success(t('acquisition.watchlist.toast.removed'));
      invalidate();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.watchlist.toast.removeFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const profiles = profilesQuery.data ?? [];
  const profileName = (id: string | null) =>
    id ? profiles.find((p) => p.id === id)?.name ?? '—' : '—';
  const items = watchlistQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-40">
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: t('acquisition.filter.allStatuses') },
              { value: 'active', label: t('acquisition.status.active') },
              { value: 'paused', label: t('acquisition.status.paused') },
            ]}
          />
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setShowBulkAdd(true)}>
              <Plus className="h-4 w-4" /> {t('acquisition.librarySeries.addFromLibrary')}
            </Button>
            <Button onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4" /> {t('acquisition.watchlist.add')}
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {watchlistQuery.isLoading ? (
            <CenteredSpinner label={t('acquisition.watchlist.loading')} />
          ) : watchlistQuery.isError ? (
            <ErrorState
              message={t('acquisition.watchlist.error')}
              onRetry={() => watchlistQuery.refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ListChecks className="h-6 w-6" />}
              title={t('acquisition.watchlist.emptyTitle')}
              description={t('acquisition.watchlist.emptyBody')}
              action={
                canManage ? (
                  <Button onClick={() => setShowAdd(true)}>
                    <Plus className="h-4 w-4" /> {t('acquisition.watchlist.add')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{t('acquisition.watchlist.col.title')}</TableHead>
                    <TableHead>{t('acquisition.watchlist.col.type')}</TableHead>
                    <TableHead>{t('acquisition.watchlist.col.detail')}</TableHead>
                    <TableHead>{t('acquisition.watchlist.col.priority')}</TableHead>
                    <TableHead>{t('acquisition.watchlist.col.profile')}</TableHead>
                    <TableHead>{t('acquisition.watchlist.col.status')}</TableHead>
                    <TableHead className="pr-4 text-right">
                      {t('acquisition.watchlist.col.actions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="pl-4 text-sm font-medium">
                        {item.title}
                        {item.year ? (
                          <span className="text-muted-foreground"> ({item.year})</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs capitalize text-muted-foreground">
                        {item.type.replace(/_/g, ' ')}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {item.seasonNumber != null ? `S${item.seasonNumber}` : ''}
                        {item.episodeNumber != null ? `E${item.episodeNumber}` : ''}
                        {item.seasonNumber == null && item.episodeNumber == null ? '—' : ''}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-muted-foreground">
                        {item.priority}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {profileName(item.profileId)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.status === 'paused' ? 'secondary' : 'success'} dot>
                          {item.status === 'paused'
                            ? t('acquisition.status.paused')
                            : t('acquisition.status.active')}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end gap-1">
                          {canManage && (
                            <>
                              <button
                                type="button"
                                onClick={() => toggleMutation.mutate(item)}
                                aria-label={
                                  item.status === 'paused'
                                    ? t('acquisition.watchlist.resume')
                                    : t('acquisition.watchlist.pause')
                                }
                                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                              >
                                {item.status === 'paused' ? (
                                  <Play className="h-4 w-4" />
                                ) : (
                                  <Pause className="h-4 w-4" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditing(item)}
                                aria-label={t('acquisition.common.edit')}
                                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      t('acquisition.watchlist.confirmRemove', { title: item.title }),
                                    )
                                  )
                                    deleteMutation.mutate(item.id);
                                }}
                                aria-label={t('acquisition.common.deleteName', { name: item.title })}
                                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddSeriesFromLibraryDialog open={showBulkAdd} onClose={() => setShowBulkAdd(false)} />
      {showAdd && (
        <WatchlistDialog profiles={profiles} onClose={() => setShowAdd(false)} onSaved={invalidate} />
      )}
      {editing && (
        <WatchlistDialog
          item={editing}
          profiles={profiles}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}

function WatchlistDialog({
  item,
  profiles,
  onClose,
  onSaved,
}: {
  item?: WatchlistItem;
  profiles: AcquisitionProfile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const isEdit = Boolean(item);
  const [form, setForm] = useState({
    type: item?.type ?? ('series' as WatchlistItemType),
    title: item?.title ?? '',
    year: item?.year != null ? String(item.year) : '',
    seasonNumber: item?.seasonNumber != null ? String(item.seasonNumber) : '',
    episodeNumber: item?.episodeNumber != null ? String(item.episodeNumber) : '',
    collectionName: '',
    priority: item?.priority != null ? String(item.priority) : '0',
    profileId: item?.profileId ?? '',
    rssRuleId: item?.rssRuleId ?? '',
    imdbId: item?.externalIds?.imdb ?? '',
  });

  // For linking a show to an RSS rule's auto-download match preferences.
  const rulesQuery = useQuery({ queryKey: ['rss', 'rules', 'all'], queryFn: () => api.rss.rules() });
  const ruleOptions = [
    { value: '', label: t('acquisition.watchlist.dialog.rssRuleNone') },
    ...(rulesQuery.data ?? []).map((r) => ({ value: r.id, label: `${r.name} (${r.feedName})` })),
  ];

  const showYear = form.type !== 'manual_query' && form.type !== 'movie_collection';
  const showSeason = form.type === 'season' || form.type === 'episode';
  const showEpisode = form.type === 'episode';
  const showCollection = form.type === 'movie_collection';
  // IMDb id makes a series/season monitorable for missing-episode scans.
  const showImdb = form.type === 'series' || form.type === 'season' || form.type === 'anime';

  const mutation = useMutation({
    mutationFn: () => {
      const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
      if (item) {
        return api.mediaAcquisition.updateWatchlist(item.id, {
          title: form.title.trim(),
          year: showYear ? num(form.year) : undefined,
          seasonNumber: showSeason ? num(form.seasonNumber) : undefined,
          episodeNumber: showEpisode ? num(form.episodeNumber) : undefined,
          collectionName: showCollection ? form.collectionName.trim() || undefined : undefined,
          priority: num(form.priority),
          profileId: form.profileId || null,
          rssRuleId: form.rssRuleId || null,
          externalIds: showImdb ? { imdb: form.imdbId.trim() } : undefined,
        });
      }
      const body: CreateWatchlistInput = {
        type: form.type,
        title: form.title.trim(),
        year: showYear ? num(form.year) : undefined,
        seasonNumber: showSeason ? num(form.seasonNumber) : undefined,
        episodeNumber: showEpisode ? num(form.episodeNumber) : undefined,
        collectionName: showCollection ? form.collectionName.trim() || undefined : undefined,
        priority: num(form.priority),
        profileId: form.profileId || undefined,
        rssRuleId: form.rssRuleId || undefined,
        externalIds: showImdb && form.imdbId.trim() ? { imdb: form.imdbId.trim() } : undefined,
      };
      return api.mediaAcquisition.createWatchlist(body);
    },
    onSuccess: () => {
      toast.success(
        isEdit
          ? t('acquisition.watchlist.toast.itemUpdated')
          : t('acquisition.watchlist.toast.added'),
      );
      onSaved();
      onClose();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.watchlist.toast.saveFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error(
        t('acquisition.watchlist.toast.titleRequired'),
        t('acquisition.watchlist.toast.titleRequiredBody'),
      );
      return;
    }
    mutation.mutate();
  };

  const typeOptions = WATCHLIST_TYPE_VALUES.map((value) => ({
    value,
    label: t(`acquisition.watchlistType.${value}`),
  }));

  const profileOptions = [
    { value: '', label: t('acquisition.filter.noProfile') },
    ...profiles.map((p) => ({ value: p.id, label: p.name })),
  ];

  const dialogTitle = isEdit
    ? t('acquisition.watchlist.dialog.editTitle')
    : t('acquisition.watchlist.dialog.addTitle');

  return (
    <Dialog open onClose={onClose} title={dialogTitle}>
      <DialogHeader>
        <DialogTitle>{dialogTitle}</DialogTitle>
        <DialogDescription>{t('acquisition.watchlist.dialog.description')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="wl-type">{t('acquisition.watchlist.dialog.type')}</Label>
            <Select
              id="wl-type"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as WatchlistItemType }))}
              options={typeOptions}
              disabled={isEdit}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wl-title">{t('acquisition.watchlist.dialog.title')}</Label>
            <Input
              id="wl-title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              autoFocus
            />
          </div>
          {showCollection && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="wl-collection">
                {t('acquisition.watchlist.dialog.collectionName')}
              </Label>
              <Input
                id="wl-collection"
                value={form.collectionName}
                onChange={(e) => setForm((f) => ({ ...f, collectionName: e.target.value }))}
                placeholder="e.g. The Lord of the Rings"
              />
            </div>
          )}
          {showImdb && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="wl-imdb">{t('acquisition.watchlist.dialog.imdbId')}</Label>
              <Input
                id="wl-imdb"
                value={form.imdbId}
                onChange={(e) => setForm((f) => ({ ...f, imdbId: e.target.value }))}
                placeholder="tt0903747"
              />
              <p className="text-xs text-muted-foreground">
                {t('acquisition.watchlist.dialog.imdbIdHint')}
              </p>
            </div>
          )}
          {showYear && (
            <div className="space-y-1.5">
              <Label htmlFor="wl-year">{t('acquisition.watchlist.dialog.year')}</Label>
              <Input
                id="wl-year"
                type="number"
                value={form.year}
                onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))}
                placeholder="2024"
              />
            </div>
          )}
          {showSeason && (
            <div className="space-y-1.5">
              <Label htmlFor="wl-season">{t('acquisition.watchlist.dialog.season')}</Label>
              <Input
                id="wl-season"
                type="number"
                value={form.seasonNumber}
                onChange={(e) => setForm((f) => ({ ...f, seasonNumber: e.target.value }))}
                placeholder="1"
              />
            </div>
          )}
          {showEpisode && (
            <div className="space-y-1.5">
              <Label htmlFor="wl-episode">{t('acquisition.watchlist.dialog.episode')}</Label>
              <Input
                id="wl-episode"
                type="number"
                value={form.episodeNumber}
                onChange={(e) => setForm((f) => ({ ...f, episodeNumber: e.target.value }))}
                placeholder="1"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="wl-priority">{t('acquisition.watchlist.dialog.priority')}</Label>
            <Input
              id="wl-priority"
              type="number"
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wl-profile">{t('acquisition.watchlist.dialog.profile')}</Label>
            <Select
              id="wl-profile"
              value={form.profileId}
              onChange={(e) => setForm((f) => ({ ...f, profileId: e.target.value }))}
              options={profileOptions}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="wl-rule">{t('acquisition.watchlist.dialog.rssRule')}</Label>
            <Select
              id="wl-rule"
              value={form.rssRuleId}
              onChange={(e) => setForm((f) => ({ ...f, rssRuleId: e.target.value }))}
              options={ruleOptions}
            />
            <p className="text-[11px] text-muted-foreground">{t('acquisition.watchlist.dialog.rssRuleHint')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('acquisition.common.cancel')}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            <Save className="h-4 w-4" />{' '}
            {isEdit ? t('acquisition.common.save') : t('acquisition.common.add')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Profiles tab
// ---------------------------------------------------------------------------

function ProfilesTab() {
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_MANAGE_PROFILES);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<AcquisitionProfile | null>(null);

  const profilesQuery = useQuery({
    queryKey: [...QK, 'profiles', 'all'],
    queryFn: () => api.mediaAcquisition.profiles(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.mediaAcquisition.deleteProfile(id),
    onSuccess: () => {
      toast.success(t('acquisition.profiles.toast.deleted'));
      queryClient.invalidateQueries({ queryKey: [...QK, 'profiles'] });
    },
    onError: (err) =>
      toast.error(
        t('acquisition.profiles.toast.deleteFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const profiles = profilesQuery.data ?? [];

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" /> {t('acquisition.profiles.add')}
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {profilesQuery.isLoading ? (
            <CenteredSpinner label={t('acquisition.profiles.loading')} />
          ) : profilesQuery.isError ? (
            <ErrorState
              message={t('acquisition.profiles.error')}
              onRetry={() => profilesQuery.refetch()}
            />
          ) : profiles.length === 0 ? (
            <EmptyState
              icon={<FlaskConical className="h-6 w-6" />}
              title={t('acquisition.profiles.emptyTitle')}
              description={t('acquisition.profiles.emptyBody')}
              action={
                canManage ? (
                  <Button onClick={() => setShowAdd(true)}>
                    <Plus className="h-4 w-4" /> {t('acquisition.profiles.add')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{t('acquisition.profiles.col.name')}</TableHead>
                    <TableHead>{t('acquisition.profiles.col.media')}</TableHead>
                    <TableHead>{t('acquisition.profiles.col.minApproval')}</TableHead>
                    <TableHead>{t('acquisition.profiles.col.preferred')}</TableHead>
                    <TableHead>{t('acquisition.profiles.col.enabled')}</TableHead>
                    <TableHead className="pr-4 text-right">
                      {t('acquisition.profiles.col.actions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profiles.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="pl-4 text-sm font-medium">{p.name}</TableCell>
                      <TableCell className="text-xs uppercase text-muted-foreground">
                        {p.mediaType}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {p.minimumScore} / {p.approvalScore}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <div className="flex flex-wrap gap-1">
                          {p.preferredResolution && (
                            <Badge variant="outline">{p.preferredResolution}</Badge>
                          )}
                          {p.preferredSource && <Badge variant="outline">{p.preferredSource}</Badge>}
                          {p.preferredCodec && <Badge variant="outline">{p.preferredCodec}</Badge>}
                          {!p.preferredResolution && !p.preferredSource && !p.preferredCodec && '—'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={p.enabled ? 'success' : 'secondary'}>
                          {p.enabled
                            ? t('acquisition.status.enabled')
                            : t('acquisition.status.disabled')}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end gap-1">
                          {canManage && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                                {t('acquisition.common.edit')}
                              </Button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      t('acquisition.profiles.confirmDelete', { name: p.name }),
                                    )
                                  )
                                    deleteMutation.mutate(p.id);
                                }}
                                aria-label={t('acquisition.common.deleteName', { name: p.name })}
                                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {showAdd && <ProfileDialog onClose={() => setShowAdd(false)} />}
      {editing && <ProfileDialog profile={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProfileDialog({
  profile,
  onClose,
}: {
  profile?: AcquisitionProfile;
  onClose: () => void;
}) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const isEdit = Boolean(profile);
  const [form, setForm] = useState({
    name: profile?.name ?? '',
    mediaType: profile?.mediaType ?? ('any' as AcquisitionMediaType),
    minimumScore: profile?.minimumScore != null ? String(profile.minimumScore) : '0',
    approvalScore: profile?.approvalScore != null ? String(profile.approvalScore) : '0',
    preferredResolution: profile?.preferredResolution ?? '',
    preferredCodec: profile?.preferredCodec ?? '',
    preferredSource: profile?.preferredSource ?? '',
    enabled: profile?.enabled ?? true,
  });
  const [requiredTerms, setRequiredTerms] = useState<string[]>(profile?.requiredTerms ?? []);
  const [excludedTerms, setExcludedTerms] = useState<string[]>(profile?.excludedTerms ?? []);
  const [preferredGroups, setPreferredGroups] = useState<string[]>(profile?.preferredGroups ?? []);

  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateAcquisitionProfileInput = {
        name: form.name.trim(),
        mediaType: form.mediaType,
        minimumScore: Number(form.minimumScore) || 0,
        approvalScore: Number(form.approvalScore) || 0,
        preferredResolution: form.preferredResolution || undefined,
        preferredCodec: form.preferredCodec || undefined,
        preferredSource: form.preferredSource || undefined,
        requiredTerms,
        excludedTerms,
        preferredGroups,
        enabled: form.enabled,
      };
      return profile
        ? api.mediaAcquisition.updateProfile(profile.id, body)
        : api.mediaAcquisition.createProfile(body);
    },
    onSuccess: () => {
      toast.success(
        isEdit ? t('acquisition.profiles.toast.updated') : t('acquisition.profiles.toast.created'),
      );
      queryClient.invalidateQueries({ queryKey: [...QK, 'profiles'] });
      onClose();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.profiles.toast.saveFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error(
        t('acquisition.profiles.toast.nameRequired'),
        t('acquisition.profiles.toast.nameRequiredBody'),
      );
      return;
    }
    mutation.mutate();
  };

  const mediaTypeOptions = MEDIA_TYPE_VALUES.map((value) => ({
    value,
    label: t(`acquisition.mediaTypeOption.${value}`),
  }));
  const resolutionOptions = [
    { value: '', label: t('acquisition.filter.any') },
    ...RESOLUTION_VALUES.map((v) => ({ value: v.split(' ')[0], label: v })),
  ];
  const sourceOptions = [
    { value: '', label: t('acquisition.filter.any') },
    ...SOURCE_VALUES.map((v) => ({ value: v, label: v })),
  ];
  const codecOptions = [{ value: '', label: t('acquisition.filter.any') }, ...CODEC_VALUES];

  const dialogTitle = isEdit
    ? t('acquisition.profiles.dialog.editTitle')
    : t('acquisition.profiles.dialog.addTitle');

  return (
    <Dialog open onClose={onClose} title={dialogTitle} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{dialogTitle}</DialogTitle>
        <DialogDescription>{t('acquisition.profiles.dialog.description')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pf-name">{t('acquisition.profiles.dialog.name')}</Label>
            <Input
              id="pf-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-media">{t('acquisition.profiles.dialog.mediaType')}</Label>
            <Select
              id="pf-media"
              value={form.mediaType}
              onChange={(e) =>
                setForm((f) => ({ ...f, mediaType: e.target.value as AcquisitionMediaType }))
              }
              options={mediaTypeOptions}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-min">{t('acquisition.profiles.dialog.minimumScore')}</Label>
            <Input
              id="pf-min"
              type="number"
              value={form.minimumScore}
              onChange={(e) => setForm((f) => ({ ...f, minimumScore: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-approval">{t('acquisition.profiles.dialog.approvalScore')}</Label>
            <Input
              id="pf-approval"
              type="number"
              value={form.approvalScore}
              onChange={(e) => setForm((f) => ({ ...f, approvalScore: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-res">{t('acquisition.profiles.dialog.preferredResolution')}</Label>
            <Select
              id="pf-res"
              value={form.preferredResolution}
              onChange={(e) => setForm((f) => ({ ...f, preferredResolution: e.target.value }))}
              options={resolutionOptions}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-source">{t('acquisition.profiles.dialog.preferredSource')}</Label>
            <Select
              id="pf-source"
              value={form.preferredSource}
              onChange={(e) => setForm((f) => ({ ...f, preferredSource: e.target.value }))}
              options={sourceOptions}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-codec">{t('acquisition.profiles.dialog.preferredCodec')}</Label>
            <Select
              id="pf-codec"
              value={form.preferredCodec}
              onChange={(e) => setForm((f) => ({ ...f, preferredCodec: e.target.value }))}
              options={codecOptions}
            />
          </div>
        </div>

        <ChipInput
          label={t('acquisition.profiles.dialog.requiredTerms')}
          values={requiredTerms}
          onChange={setRequiredTerms}
          placeholder={t('acquisition.profiles.dialog.termPlaceholder')}
        />
        <ChipInput
          label={t('acquisition.profiles.dialog.excludedTerms')}
          values={excludedTerms}
          onChange={setExcludedTerms}
          placeholder="e.g. CAM, HDCAM"
        />
        <ChipInput
          label={t('acquisition.profiles.dialog.preferredGroups')}
          values={preferredGroups}
          onChange={setPreferredGroups}
          placeholder={t('acquisition.profiles.dialog.groupsPlaceholder')}
        />

        <label className="flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            className="h-4 w-4 rounded border-input bg-white/[0.02]"
          />
          {t('acquisition.status.enabled')}
        </label>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('acquisition.common.cancel')}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            <Save className="h-4 w-4" />{' '}
            {isEdit ? t('acquisition.common.save') : t('acquisition.profiles.dialog.create')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Evaluations tab
// ---------------------------------------------------------------------------

function EvaluationsTab() {
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canEvaluate = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_EVALUATE);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [decisionFilter, setDecisionFilter] = useState('');

  const [testForm, setTestForm] = useState({ releaseName: '', profileId: '' });
  const [testResult, setTestResult] = useState<AcquisitionEvaluation | null>(null);

  const evaluationsQuery = useQuery({
    queryKey: [...QK, 'evaluations', decisionFilter],
    queryFn: () =>
      api.mediaAcquisition.evaluations(decisionFilter ? { decision: decisionFilter } : {}),
  });

  const profilesQuery = useQuery({
    queryKey: [...QK, 'profiles', 'all'],
    queryFn: () => api.mediaAcquisition.profiles(),
  });

  const evaluateMutation = useMutation({
    mutationFn: () =>
      api.mediaAcquisition.evaluate({
        releaseName: testForm.releaseName.trim(),
        profileId: testForm.profileId || undefined,
      }),
    onSuccess: (res) => {
      setTestResult(res);
      toast.success(
        t('acquisition.evaluations.toast.complete'),
        t('acquisition.evaluations.toast.completeBody', {
          decision: t(`acquisition.decision.${res.decision}`),
        }),
      );
      queryClient.invalidateQueries({ queryKey: [...QK, 'evaluations'] });
      queryClient.invalidateQueries({ queryKey: [...QK, 'approval-queue'] });
      queryClient.invalidateQueries({ queryKey: [...QK, 'overview'] });
    },
    onError: (err) =>
      toast.error(
        t('acquisition.evaluations.toast.failed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const profiles = profilesQuery.data ?? [];
  const evaluations = evaluationsQuery.data ?? [];

  return (
    <div className="space-y-4">
      {canEvaluate && (
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FlaskConical className="h-4 w-4 text-info" /> {t('acquisition.evaluations.testEvaluate')}
            </div>
            <div className="grid gap-4 lg:grid-cols-[1fr_220px_auto] lg:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="ev-release">{t('acquisition.evaluations.releaseName')}</Label>
                <Input
                  id="ev-release"
                  value={testForm.releaseName}
                  onChange={(e) =>
                    setTestForm((f) => ({ ...f, releaseName: e.target.value }))
                  }
                  placeholder="Some.Show.S01E02.1080p.WEB-DL.x265-GROUP"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ev-profile">{t('acquisition.evaluations.profileOptional')}</Label>
                <Select
                  id="ev-profile"
                  value={testForm.profileId}
                  onChange={(e) => setTestForm((f) => ({ ...f, profileId: e.target.value }))}
                  options={[
                    { value: '', label: t('acquisition.filter.autoSelect') },
                    ...profiles.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </div>
              <Button
                onClick={() => {
                  if (!testForm.releaseName.trim()) {
                    toast.error(
                      t('acquisition.evaluations.toast.releaseRequired'),
                      t('acquisition.evaluations.toast.releaseRequiredBody'),
                    );
                    return;
                  }
                  evaluateMutation.mutate();
                }}
                loading={evaluateMutation.isPending}
              >
                <FlaskConical className="h-4 w-4" /> {t('acquisition.evaluations.evaluate')}
              </Button>
            </div>

            {testResult && (
              <div className="space-y-3 rounded-md border border-border/60 bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <DecisionBadge decision={testResult.decision} />
                  <span className="text-sm text-muted-foreground">{testResult.decisionReason}</span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {t('acquisition.evaluations.confidenceScore', {
                      confidence: formatPercent(testResult.confidence),
                      score: scoreValue(testResult.releaseScore),
                    })}
                  </span>
                </div>
                <details className="group">
                  <summary className="cursor-pointer text-xs font-medium text-primary hover:underline">
                    {t('acquisition.evaluations.traceSummary', {
                      count: testResult.trace?.steps?.length ?? 0,
                    })}
                  </summary>
                  <div className="mt-3">
                    <TraceView steps={testResult.trace?.steps ?? []} />
                  </div>
                </details>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {t('acquisition.evaluations.recent')}
        </h2>
        <div className="w-44">
          <Select
            value={decisionFilter}
            onChange={(e) => setDecisionFilter(e.target.value)}
            options={[
              { value: '', label: t('acquisition.filter.allDecisions') },
              ...OVERRIDE_DECISION_VALUES.map((value) => ({
                value,
                label: t(`acquisition.decision.${value}`),
              })),
            ]}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {evaluationsQuery.isLoading ? (
            <CenteredSpinner label={t('acquisition.evaluations.loading')} />
          ) : evaluationsQuery.isError ? (
            <ErrorState
              message={t('acquisition.evaluations.error')}
              onRetry={() => evaluationsQuery.refetch()}
            />
          ) : evaluations.length === 0 ? (
            <EmptyState
              icon={<FlaskConical className="h-6 w-6" />}
              title={t('acquisition.evaluations.emptyTitle')}
              description={t('acquisition.evaluations.emptyBody')}
            />
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{t('acquisition.evaluations.col.release')}</TableHead>
                    <TableHead>{t('acquisition.evaluations.col.decision')}</TableHead>
                    <TableHead>{t('acquisition.evaluations.col.reason')}</TableHead>
                    <TableHead>{t('acquisition.evaluations.col.confidence')}</TableHead>
                    <TableHead className="pr-4">{t('acquisition.evaluations.col.score')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {evaluations.map((ev) => (
                    <TableRow
                      key={ev.id}
                      onClick={() => setDetailId(ev.id)}
                      className="cursor-pointer"
                    >
                      <TableCell
                        className="max-w-[280px] truncate pl-4 font-mono text-xs"
                        title={ev.releaseName}
                      >
                        {ev.releaseName}
                      </TableCell>
                      <TableCell>
                        <DecisionBadge decision={ev.decision} />
                      </TableCell>
                      <TableCell
                        className="max-w-[240px] truncate text-xs text-muted-foreground"
                        title={ev.decisionReason}
                      >
                        {ev.decisionReason || '—'}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {formatPercent(ev.confidence)}
                      </TableCell>
                      <TableCell className="pr-4 text-xs tabular-nums text-muted-foreground">
                        {scoreValue(ev.releaseScore)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {detailId && (
        <EvaluationDetailDialog evaluationId={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

function EvaluationDetailDialog({
  evaluationId,
  onClose,
}: {
  evaluationId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('media');
  const detailQuery = useQuery({
    queryKey: [...QK, 'evaluation', evaluationId],
    queryFn: () => api.mediaAcquisition.evaluation(evaluationId),
  });

  const ev: AcquisitionEvaluationDetail | undefined = detailQuery.data;
  const yes = t('acquisition.common.yes');
  const no = t('acquisition.common.no');

  return (
    <Dialog open onClose={onClose} title={t('acquisition.evaluations.detail.title')} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('acquisition.evaluations.detail.title')}</DialogTitle>
        <DialogDescription>{t('acquisition.evaluations.detail.description')}</DialogDescription>
      </DialogHeader>

      {detailQuery.isLoading ? (
        <CenteredSpinner label={t('acquisition.evaluations.detail.loading')} />
      ) : detailQuery.isError ? (
        <ErrorState
          message={t('acquisition.evaluations.detail.error')}
          onRetry={() => detailQuery.refetch()}
        />
      ) : ev ? (
        <div className="space-y-4">
          <p className="break-all font-mono text-xs">{ev.releaseName}</p>
          <div className="flex flex-wrap items-center gap-2">
            <DecisionBadge decision={ev.decision} />
            <Badge variant={approvalVariant(ev.approvalStatus)} className="capitalize">
              {ev.approvalStatus.replace(/_/g, ' ')}
            </Badge>
            <span className="text-xs text-muted-foreground">{ev.decisionReason}</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border/60 bg-white/[0.02] px-3 py-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {t('acquisition.evaluations.detail.score')}
              </p>
              <p className="text-sm font-semibold tabular-nums">{scoreValue(ev.releaseScore)}</p>
            </div>
            <div className="rounded-md border border-border/60 bg-white/[0.02] px-3 py-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {t('acquisition.evaluations.detail.libraryMatch')}
              </p>
              <p
                className="truncate text-sm font-semibold"
                title={renderMeta(ev.libraryMatch, yes, no)}
              >
                {renderMeta(ev.libraryMatch, yes, no)}
              </p>
            </div>
            <div className="rounded-md border border-border/60 bg-white/[0.02] px-3 py-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {t('acquisition.evaluations.detail.duplicateRisk')}
              </p>
              <p
                className="truncate text-sm font-semibold"
                title={renderMeta(ev.duplicateRisk, yes, no)}
              >
                {renderMeta(ev.duplicateRisk, yes, no)}
              </p>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold">
              {t('acquisition.evaluations.detail.decisionTrace')}
            </p>
            <TraceView steps={ev.trace?.steps ?? []} />
          </div>

          {ev.actions && ev.actions.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold">
                {t('acquisition.evaluations.detail.actions')}
              </p>
              <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                {ev.actions.map((a, i) => (
                  <li key={a.id ?? i} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-sm capitalize">
                      {(a.actionType ?? 'action').replace(/_/g, ' ')}
                    </span>
                    <div className="flex items-center gap-2">
                      {a.message && (
                        <span className="text-xs text-muted-foreground">{a.message}</span>
                      )}
                      {a.status && (
                        <Badge variant="outline" className="capitalize">
                          {a.status}
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      <DialogFooter>
        <Button onClick={onClose}>{t('acquisition.common.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Approval queue tab
// ---------------------------------------------------------------------------

function ApprovalQueueTab() {
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canApprove = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_APPROVE);
  const canReject = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_REJECT);
  const canOverride = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_OVERRIDE);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reasonFor, setReasonFor] = useState<{ kind: 'reject' | 'override'; ev: AcquisitionEvaluation } | null>(null);

  const queueQuery = useQuery({
    queryKey: [...QK, 'approval-queue'],
    queryFn: api.mediaAcquisition.approvalQueue,
    refetchInterval: 20_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [...QK, 'evaluations'] });
    queryClient.invalidateQueries({ queryKey: [...QK, 'approval-queue'] });
    queryClient.invalidateQueries({ queryKey: [...QK, 'overview'] });
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.mediaAcquisition.approve(id),
    onSuccess: () => {
      toast.success(t('acquisition.approvals.toast.approved'));
      invalidate();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.approvals.toast.approveFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const queue = queueQuery.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          {queueQuery.isLoading ? (
            <CenteredSpinner label={t('acquisition.approvals.loading')} />
          ) : queueQuery.isError ? (
            <ErrorState
              message={t('acquisition.approvals.error')}
              onRetry={() => queueQuery.refetch()}
            />
          ) : queue.length === 0 ? (
            <EmptyState
              icon={<Gavel className="h-6 w-6" />}
              title={t('acquisition.approvals.emptyTitle')}
              description={t('acquisition.approvals.emptyBody')}
            />
          ) : (
            <ul className="divide-y divide-border/60">
              {queue.map((ev) => (
                <li key={ev.id} className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm" title={ev.releaseName}>
                      {ev.releaseName}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <DecisionBadge decision={ev.decision} />
                      <span className="text-xs text-muted-foreground">{ev.decisionReason}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {t('acquisition.approvals.scoreConfidence', {
                          score: scoreValue(ev.releaseScore),
                          confidence: formatPercent(ev.confidence),
                        })}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canApprove && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => approveMutation.mutate(ev.id)}
                        loading={approveMutation.isPending && approveMutation.variables === ev.id}
                      >
                        <ThumbsUp className="h-4 w-4" /> {t('acquisition.approvals.approve')}
                      </Button>
                    )}
                    {canReject && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setReasonFor({ kind: 'reject', ev })}
                      >
                        <ThumbsDown className="h-4 w-4" /> {t('acquisition.approvals.reject')}
                      </Button>
                    )}
                    {canOverride && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReasonFor({ kind: 'override', ev })}
                      >
                        <Gavel className="h-4 w-4" /> {t('acquisition.approvals.override')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {reasonFor?.kind === 'reject' && (
        <RejectDialog
          evaluation={reasonFor.ev}
          onClose={() => setReasonFor(null)}
          onDone={invalidate}
        />
      )}
      {reasonFor?.kind === 'override' && (
        <OverrideDialog
          evaluation={reasonFor.ev}
          onClose={() => setReasonFor(null)}
          onDone={invalidate}
        />
      )}
    </div>
  );
}

function RejectDialog({
  evaluation,
  onClose,
  onDone,
}: {
  evaluation: AcquisitionEvaluation;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.mediaAcquisition.reject(evaluation.id, reason.trim() || undefined),
    onSuccess: () => {
      toast.success(t('acquisition.approvals.toast.rejected'));
      onDone();
      onClose();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.approvals.toast.rejectFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });
  return (
    <Dialog open onClose={onClose} title={t('acquisition.approvals.rejectDialog.title')}>
      <DialogHeader>
        <DialogTitle>{t('acquisition.approvals.rejectDialog.title')}</DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">
          {evaluation.releaseName}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="reject-reason">{t('acquisition.approvals.reasonOptional')}</Label>
        <Textarea
          id="reject-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('acquisition.approvals.rejectDialog.placeholder')}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('acquisition.common.cancel')}
        </Button>
        <Button variant="destructive" onClick={() => mutation.mutate()} loading={mutation.isPending}>
          <ThumbsDown className="h-4 w-4" /> {t('acquisition.approvals.reject')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function OverrideDialog({
  evaluation,
  onClose,
  onDone,
}: {
  evaluation: AcquisitionEvaluation;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const [decision, setDecision] = useState<MediaAcquisitionDecision>('download');
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api.mediaAcquisition.override(evaluation.id, decision, reason.trim() || undefined),
    onSuccess: () => {
      toast.success(t('acquisition.approvals.toast.overridden'));
      onDone();
      onClose();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.approvals.toast.overrideFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });
  const decisionOptions = OVERRIDE_DECISION_VALUES.map((value) => ({
    value,
    label: t(`acquisition.decision.${value}`),
  }));
  return (
    <Dialog open onClose={onClose} title={t('acquisition.approvals.overrideDialog.title')}>
      <DialogHeader>
        <DialogTitle>{t('acquisition.approvals.overrideDialog.title')}</DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">
          {evaluation.releaseName}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ov-decision">{t('acquisition.approvals.overrideDialog.newDecision')}</Label>
          <Select
            id="ov-decision"
            value={decision}
            onChange={(e) => setDecision(e.target.value as MediaAcquisitionDecision)}
            options={decisionOptions}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ov-reason">{t('acquisition.approvals.reasonOptional')}</Label>
          <Textarea
            id="ov-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('acquisition.approvals.overrideDialog.placeholder')}
          />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('acquisition.common.cancel')}
        </Button>
        <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
          <Gavel className="h-4 w-4" /> {t('acquisition.approvals.override')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Recommendations tab
// ---------------------------------------------------------------------------

function RecommendationsTab() {
  const { t } = useTranslation('media');
  const recQuery = useQuery({
    queryKey: [...QK, 'recommendations'],
    queryFn: api.mediaAcquisition.recommendations,
    refetchInterval: 30_000,
  });

  if (recQuery.isLoading) return <CenteredSpinner label={t('acquisition.recommendations.loading')} />;
  if (recQuery.isError)
    return (
      <ErrorState
        message={t('acquisition.recommendations.error')}
        onRetry={() => recQuery.refetch()}
      />
    );

  const data = recQuery.data;
  if (!data) return null;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <RecommendationSection
        icon={<Gavel className="h-4 w-4 text-warning" />}
        title={t('acquisition.recommendations.pendingApprovals')}
        empty={t('acquisition.recommendations.pendingEmpty')}
        items={data.pendingApprovals.map((p) => ({
          id: p.id,
          primary: p.releaseName,
          secondary: p.reason,
        }))}
      />
      <RecommendationSection
        icon={<TrendingUp className="h-4 w-4 text-info" />}
        title={t('acquisition.recommendations.qualityUpgrades')}
        empty={t('acquisition.recommendations.upgradesEmpty')}
        items={data.qualityUpgrades.map((q) => ({ id: q.id, primary: q.releaseName }))}
      />
      <RecommendationSection
        icon={<ListChecks className="h-4 w-4 text-muted-foreground" />}
        title={t('acquisition.recommendations.noMatches')}
        empty={t('acquisition.recommendations.noMatchesEmpty')}
        items={data.watchlistWithNoMatches.map((w) => ({ id: w.id, primary: w.title }))}
      />
    </div>
  );
}

function RecommendationSection({
  icon,
  title,
  empty,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  items: { id: string; primary: string; secondary?: string }[];
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        {icon} {title}
        <Badge variant="secondary" className="ml-auto">
          {items.length}
        </Badge>
      </h2>
      <Card>
        <CardContent className="p-0">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">{empty}</div>
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((item) => (
                <li key={item.id} className="px-4 py-3">
                  <p className="truncate font-mono text-xs" title={item.primary}>
                    {item.primary}
                  </p>
                  {item.secondary && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.secondary}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

function HistoryTab() {
  const { t } = useTranslation('media');
  const historyQuery = useQuery({
    queryKey: [...QK, 'history'],
    queryFn: () => api.mediaAcquisition.history(200),
    refetchInterval: 30_000,
  });

  const events = historyQuery.data ?? [];

  return (
    <Card>
      <CardContent className="p-0">
        {historyQuery.isLoading ? (
          <CenteredSpinner label={t('acquisition.history.loading')} />
        ) : historyQuery.isError ? (
          <ErrorState
            message={t('acquisition.history.error')}
            onRetry={() => historyQuery.refetch()}
          />
        ) : events.length === 0 ? (
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title={t('acquisition.history.emptyTitle')}
            description={t('acquisition.history.emptyBody')}
          />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">{t('acquisition.history.col.event')}</TableHead>
                  <TableHead>{t('acquisition.history.col.message')}</TableHead>
                  <TableHead className="pr-4">{t('acquisition.history.col.when')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((evt, i) => (
                  <TableRow key={`${evt.eventType}-${i}`}>
                    <TableCell className="pl-4">
                      <span className="flex items-center gap-2 font-mono text-xs">
                        <ScrollText className="h-3.5 w-3.5 text-muted-foreground" />
                        {evt.eventType}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{evt.message}</TableCell>
                    <TableCell className="pr-4 text-xs tabular-nums text-muted-foreground">
                      {formatDateTime(evt.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function SettingsTab() {
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_SETTINGS);
  const canExport = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_EXPORT);
  const toast = useToast();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: [...QK, 'settings'],
    queryFn: api.mediaAcquisition.settings,
  });

  const profilesQuery = useQuery({
    queryKey: [...QK, 'profiles', 'all'],
    queryFn: () => api.mediaAcquisition.profiles(),
  });

  const [form, setForm] = useState<AcquisitionSettings | null>(null);

  const saveMutation = useMutation({
    mutationFn: (body: Partial<AcquisitionSettings>) => api.mediaAcquisition.updateSettings(body),
    onSuccess: (res) => {
      toast.success(t('acquisition.settings.toast.saved'));
      setForm(res);
      queryClient.invalidateQueries({ queryKey: [...QK, 'settings'] });
    },
    onError: (err) =>
      toast.error(
        t('acquisition.settings.toast.saveFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const exportMutation = useMutation({
    mutationFn: () =>
      api.mediaAcquisition.export({ evaluations: true, watchlist: true, profiles: true }),
    onSuccess: () => toast.success(t('acquisition.settings.toast.exported')),
    onError: (err) =>
      toast.error(
        t('acquisition.settings.toast.exportFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  if (settingsQuery.isLoading) return <CenteredSpinner label={t('acquisition.settings.loading')} />;
  if (settingsQuery.isError)
    return (
      <ErrorState
        message={t('acquisition.settings.error')}
        onRetry={() => settingsQuery.refetch()}
      />
    );

  const current = form ?? settingsQuery.data;
  if (!current) return null;

  const profiles = profilesQuery.data ?? [];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    saveMutation.mutate({
      autoEvaluateRss: current.autoEvaluateRss,
      defaultProfileId: current.defaultProfileId,
      approvalExpiryHours: current.approvalExpiryHours,
      notifyOnApprovalRequired: current.notifyOnApprovalRequired,
    });
  };

  const update = (patch: Partial<AcquisitionSettings>) =>
    setForm({ ...(form ?? settingsQuery.data!), ...patch });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5">
          <form onSubmit={submit} className="space-y-5">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={current.autoEvaluateRss}
                disabled={!canManage}
                onChange={(e) => update({ autoEvaluateRss: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-input bg-white/[0.02]"
              />
              <span>
                <span className="text-sm font-medium">{t('acquisition.settings.autoEvaluate')}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('acquisition.settings.autoEvaluateHint')}
                </span>
              </span>
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="set-default-profile">
                  {t('acquisition.settings.defaultProfile')}
                </Label>
                <Select
                  id="set-default-profile"
                  value={current.defaultProfileId ?? ''}
                  disabled={!canManage}
                  onChange={(e) => update({ defaultProfileId: e.target.value || null })}
                  options={[
                    { value: '', label: t('acquisition.filter.none') },
                    ...profiles.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="set-expiry">{t('acquisition.settings.approvalExpiry')}</Label>
                <Input
                  id="set-expiry"
                  type="number"
                  value={String(current.approvalExpiryHours)}
                  disabled={!canManage}
                  onChange={(e) => update({ approvalExpiryHours: Number(e.target.value) || 0 })}
                />
              </div>
            </div>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={current.notifyOnApprovalRequired}
                disabled={!canManage}
                onChange={(e) => update({ notifyOnApprovalRequired: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-input bg-white/[0.02]"
              />
              <span>
                <span className="text-sm font-medium">{t('acquisition.settings.notify')}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('acquisition.settings.notifyHint')}
                </span>
              </span>
            </label>

            {canManage && (
              <div className="flex justify-end">
                <Button type="submit" loading={saveMutation.isPending}>
                  <Save className="h-4 w-4" /> {t('acquisition.settings.save')}
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {canExport && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <p className="text-sm font-semibold">{t('acquisition.settings.exportTitle')}</p>
              <p className="text-xs text-muted-foreground">
                {t('acquisition.settings.exportHint')}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => exportMutation.mutate()}
              loading={exportMutation.isPending}
            >
              <Download className="h-4 w-4" /> {t('acquisition.settings.exportButton')}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
