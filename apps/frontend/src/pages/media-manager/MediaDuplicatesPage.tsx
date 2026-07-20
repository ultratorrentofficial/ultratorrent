import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, EyeOff, RotateCcw, ScanSearch, Star } from 'lucide-react';
import { ApiError, api, type MediaDuplicateGroup } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { duplicateReasonLabel, seasonEpisodeLabel } from './constants';
import { DuplicateShowsPanel } from './DuplicateShowsPanel';
import { DuplicateComparison, CompareToggleButton } from './DuplicateComparison';
import { DuplicateTrashPanel } from './DuplicateTrashPanel';
import { QuickCleanPanel } from './QuickCleanPanel';

const DUPES_PAGE_SIZE = 25;

/**
 * Tabs are views over ONE server-side query, not client-side slices of a bulk
 * download — each carries the filter the server applies, so a 30k-file library pages
 * the same as a small one.
 *
 * Only tabs with a real backend behind them exist. Trash & Recovery and Settings
 * arrive with the phases that implement them rather than shipping as empty shells.
 */
const TABS = [
  { id: 'review', filter: { status: 'open', requiresReview: 'true' } },
  { id: 'all', filter: { status: 'open' } },
  { id: 'quick', filter: null },
  { id: 'movies', filter: { status: 'open', mediaType: 'movie' } },
  { id: 'episodes', filter: { status: 'open', mediaType: 'tv' } },
  { id: 'folders', filter: null },
  { id: 'ignored', filter: { status: 'ignored' } },
  { id: 'resolved', filter: { status: 'resolved' } },
  { id: 'trash', filter: null },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function MediaDuplicatesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('media');

  const [tab, setTab] = useState<TabId | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('needs_review');

  const overview = useQuery({
    queryKey: ['media', 'duplicates', 'overview'],
    queryFn: () => api.media.duplicatesOverview(),
  });

  // Needs Review is the intended landing tab, but landing on it when it is empty
  // shows a blank screen to an operator who has hundreds of duplicate groups — which
  // is exactly the "where is everything?" confusion this redesign exists to remove.
  // Nothing sets `requiresReview` until the recommendation engine lands, so the
  // opening tab is chosen from the overview: Needs Review when it has something to
  // show, All Open otherwise. Once a group needs a decision, the default moves to it
  // on its own. An explicit click always wins.
  const resolvedTab: TabId = tab ?? (overview.data && overview.data.needsReview > 0 ? 'review' : 'all');
  const active = TABS.find((x) => x.id === resolvedTab)!;

  const groups = useQuery({
    queryKey: ['media', 'duplicates', 'list', resolvedTab, page, search, sort],
    queryFn: () =>
      api.media.listDuplicates({
        page,
        pageSize: DUPES_PAGE_SIZE,
        sort,
        ...(search.trim() ? { q: search.trim() } : {}),
        ...(active.filter ?? {}),
      }),
    enabled: active.filter != null,
    placeholderData: keepPreviousData,
  });

  const detect = useMutation({
    mutationFn: api.media.detectDuplicates,
    onSuccess: (result) => {
      toast.success(
        t('duplicates.detectionCompleteTitle'),
        t('duplicates.detectionCompleteBody', { count: result.total }),
      );
      setPage(1);
      void queryClient.invalidateQueries({ queryKey: ['media', 'duplicates'] });
    },
    onError: (err) =>
      toast.error(t('duplicates.detectionFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const o = overview.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('duplicates.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('duplicates.subtitle')}</p>
        </div>
        <Button variant="secondary" onClick={() => detect.mutate()} loading={detect.isPending}>
          <ScanSearch className="h-4 w-4" /> {t('duplicates.detectBtn')}
        </Button>
      </div>

      {/* One aggregate call — no group rows are loaded to produce these. */}
      {o ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label={t('duplicates.stat.open')} value={String(o.groups.open)} />
          <StatTile label={t('duplicates.stat.needsReview')} value={String(o.needsReview)} />
          <StatTile label={t('duplicates.stat.ignored')} value={String(o.groups.ignored)} />
          <StatTile
            label={t('duplicates.stat.lastScan')}
            value={o.lastDetectedAt ? new Date(o.lastDetectedAt).toLocaleDateString() : '—'}
          />
        </div>
      ) : null}

      <Tabs
        value={resolvedTab}
        onValueChange={(v) => {
          setTab(v as TabId);
          setPage(1);
        }}
      >
        <TabsList>
          {TABS.map((x) => (
            <TabsTrigger key={x.id} value={x.id}>
              {t(`duplicates.tab.${x.id}` as 'duplicates.tab.review')}
            </TabsTrigger>
          ))}
        </TabsList>

        {TABS.map((x) => (
          <TabsContent key={x.id} value={x.id} className="space-y-4">
            {x.id === 'quick' ? (
              <QuickCleanPanel />
            ) : x.id === 'trash' ? (
              <DuplicateTrashPanel />
            ) : x.filter == null ? (
              <section className="space-y-3">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">{t('shows.dupes.title')}</h2>
                  <p className="text-sm text-muted-foreground">{t('shows.dupes.subtitle')}</p>
                </div>
                <DuplicateShowsPanel />
              </section>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[12rem] flex-1">
                    <label
                      htmlFor="dupe-search"
                      className="mb-1 block text-xs font-medium text-muted-foreground"
                    >
                      {t('duplicates.filter.search')}
                    </label>
                    <Input
                      id="dupe-search"
                      value={search}
                      placeholder={t('duplicates.filter.searchPlaceholder')}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(1);
                      }}
                    />
                  </div>
                  <div className="w-56">
                    <label
                      htmlFor="dupe-sort"
                      className="mb-1 block text-xs font-medium text-muted-foreground"
                    >
                      {t('duplicates.filter.sort')}
                    </label>
                    <Select
                      id="dupe-sort"
                      value={sort}
                      onChange={(e) => {
                        setSort(e.target.value);
                        setPage(1);
                      }}
                      options={[
                        { value: 'needs_review', label: t('duplicates.sort.needsReview') },
                        { value: 'savings_desc', label: t('duplicates.sort.savings') },
                        { value: 'files_desc', label: t('duplicates.sort.files') },
                        { value: 'recent', label: t('duplicates.sort.recent') },
                        { value: 'oldest', label: t('duplicates.sort.oldest') },
                        { value: 'title', label: t('duplicates.sort.title') },
                      ]}
                    />
                  </div>
                </div>

                <DuplicateList
                  data={groups.data}
                  isLoading={groups.isLoading}
                  isError={groups.isError}
                  isFetching={groups.isFetching}
                  onRetry={() => void groups.refetch()}
                  page={page}
                  onPage={setPage}
                  onDetect={() => detect.mutate()}
                  detecting={detect.isPending}
                  tab={x.id}
                />
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function DuplicateList({
  data,
  isLoading,
  isError,
  isFetching,
  onRetry,
  page,
  onPage,
  onDetect,
  detecting,
  tab,
}: {
  data?: { items: MediaDuplicateGroup[]; total: number };
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  onRetry: () => void;
  page: number;
  onPage: (p: number) => void;
  onDetect: () => void;
  detecting: boolean;
  tab: TabId;
}) {
  const { t } = useTranslation('media');

  if (isLoading) return <CenteredSpinner label={t('duplicates.loading')} />;
  if (isError) return <ErrorState message={t('duplicates.error')} onRetry={onRetry} />;

  const groups = data?.items ?? [];
  if (!groups.length) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<Copy className="h-6 w-6" />}
            title={t(`duplicates.empty.${tab}.title` as 'duplicates.empty.review.title')}
            description={t(`duplicates.empty.${tab}.body` as 'duplicates.empty.review.body')}
            action={
              tab === 'review' || tab === 'all' ? (
                <Button variant="secondary" onClick={onDetect} loading={detecting}>
                  <ScanSearch className="h-4 w-4" /> {t('duplicates.detectBtn')}
                </Button>
              ) : undefined
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <DuplicateGroupCard key={g.id} group={g} />
      ))}
      <Pagination
        page={page}
        pageSize={DUPES_PAGE_SIZE}
        total={data?.total ?? 0}
        onPage={onPage}
        busy={isFetching}
      />
    </div>
  );
}

function DuplicateGroupCard({ group }: { group: MediaDuplicateGroup }) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('media');
  const [comparing, setComparing] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['media', 'duplicates'] });
  };

  const ignore = useMutation({
    mutationFn: () => api.media.ignoreDuplicateGroup(group.id),
    onSuccess: () => {
      toast.success(t('duplicates.ignoredTitle'), t('duplicates.ignoredBody'));
      invalidate();
    },
    onError: (err) =>
      toast.error(t('duplicates.ignoreFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const reopen = useMutation({
    mutationFn: () => api.media.reopenDuplicateGroup(group.id),
    onSuccess: () => {
      toast.success(t('duplicates.reopenedTitle'), t('duplicates.reopenedBody'));
      invalidate();
    },
    onError: (err) =>
      toast.error(t('duplicates.reopenFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const title = group.items[0]?.title ?? t('duplicates.groupFallbackTitle');

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{title}</h3>
            <Badge variant="info">{duplicateReasonLabel(t, group.reason)}</Badge>
            {group.requiresReview ? (
              <Badge variant="destructive">{t('duplicates.badge.reviewRequired')}</Badge>
            ) : null}
            {group.status === 'ignored' ? (
              <Badge variant="secondary">{t('duplicates.badge.ignored')}</Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {t('duplicates.itemsCount', { count: group.items.length })}
            </span>
            {group.potentialSavingsBytes > 0 ? (
              <span className="text-xs text-muted-foreground">
                {t('duplicates.reclaimable', { size: formatBytes(group.potentialSavingsBytes) })}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <CompareToggleButton open={comparing} onToggle={() => setComparing((v) => !v)} />
            {group.status === 'open' ? (
              <Button variant="ghost" size="sm" onClick={() => ignore.mutate()} loading={ignore.isPending}>
                <EyeOff className="h-3.5 w-3.5" /> {t('duplicates.notDuplicates')}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => reopen.mutate()} loading={reopen.isPending}>
                <RotateCcw className="h-3.5 w-3.5" /> {t('duplicates.reopen')}
              </Button>
            )}
          </div>
        </div>

        {group.ignoredReason ? (
          <p className="text-xs text-muted-foreground">
            {t('duplicates.ignoredReasonLabel', { reason: group.ignoredReason })}
          </p>
        ) : null}

        {comparing ? (
          <DuplicateComparison groupId={group.id} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('duplicates.col.item')}</TableHead>
                <TableHead>{t('duplicates.col.year')}</TableHead>
                <TableHead>{t('duplicates.col.se')}</TableHead>
                <TableHead>{t('duplicates.col.resolution')}</TableHead>
                <TableHead>{t('duplicates.col.size')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="flex items-start gap-1.5">
                      {item.id === group.suggestedKeepId ? (
                        <Star
                          className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                          aria-label={t('duplicates.suggestedKeepAria')}
                        />
                      ) : (
                        <span className="w-4 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="truncate text-left text-sm font-medium hover:underline"
                          onClick={() => navigate(`/media/items/${item.id}`)}
                        >
                          {item.title}
                        </button>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{item.path}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{item.year ?? '—'}</TableCell>
                  <TableCell>{seasonEpisodeLabel(item.season, item.episode) || '—'}</TableCell>
                  <TableCell>{item.bestResolution ?? '—'}</TableCell>
                  <TableCell>{formatBytes(item.totalSize)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
