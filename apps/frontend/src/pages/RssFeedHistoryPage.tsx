import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import {
  ApiError,
  api,
  type RssFeed,
  type RssHistoryItem,
  type RssHistoryStatus,
  type SmartAnalyzeResult,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState, Spinner } from '@/components/ui/feedback';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const PAGE_SIZES = [25, 50, 100];

type StatusTone = 'success' | 'info' | 'warning';

function statusOf(item: RssHistoryItem): { key: 'downloaded' | 'matched' | 'seen'; variant: StatusTone } {
  if (item.downloaded) return { key: 'downloaded', variant: 'success' };
  if (item.matched) return { key: 'matched', variant: 'info' };
  return { key: 'seen', variant: 'warning' };
}

export function RssFeedHistoryPage() {
  const { feedId = '' } = useParams<{ feedId: string }>();
  const { t } = useTranslation('rss');
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [ruleFor, setRuleFor] = useState<RssHistoryItem | null>(null);
  const [status, setStatus] = useState<RssHistoryStatus | 'all'>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Debounce the title search so we don't refetch on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Any filter change returns to the first page (the old page may not exist).
  useEffect(() => setPage(1), [status, search, from, to]);

  const feedsQuery = useQuery({ queryKey: ['rss'], queryFn: api.rss.list });
  const feed = feedsQuery.data?.find((f) => f.id === feedId);

  const filtered = status !== 'all' || search !== '' || from !== '' || to !== '';
  const historyKey = ['rss', 'history', feedId, page, pageSize, status, search, from, to];
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: historyKey,
    queryFn: () =>
      api.rss.history(feedId, {
        page,
        pageSize,
        status: status === 'all' ? undefined : status,
        search: search || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    enabled: !!feedId,
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts ?? { total: 0, downloaded: 0, matched: 0, seen: 0 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const toggleStatus = (key: RssHistoryStatus) =>
    setStatus((s) => (s === key ? 'all' : key));
  const clearFilters = () => {
    setStatus('all');
    setSearchInput('');
    setFrom('');
    setTo('');
  };

  const invalidateHistory = () =>
    queryClient.invalidateQueries({ queryKey: ['rss', 'history', feedId] });

  const fetchNow = async () => {
    setRefreshing(true);
    try {
      const { newItems, downloaded } = await api.rss.refreshFeed(feedId);
      toast.success(
        t('history.toast.feedFetched'),
        newItems === 0
          ? t('history.toast.noNewItems')
          : t('history.toast.newItems', { count: newItems }) +
              (downloaded > 0 ? t('history.toast.downloadedSuffix', { count: downloaded }) : ''),
      );
      invalidateHistory();
    } catch (err) {
      toast.error(t('history.toast.fetchFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setRefreshing(false);
    }
  };

  const download = async (item: RssHistoryItem) => {
    setDownloadingId(item.id);
    try {
      await api.rss.downloadHistoryItem(item.id);
      toast.success(t('history.toast.downloadStarted'), item.title);
      invalidateHistory();
    } catch (err) {
      toast.error(t('history.toast.downloadFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setDownloadingId(null);
    }
  };

  const changePageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/rss')} className="mb-2 -ml-2">
          <ArrowLeft className="h-4 w-4" /> {t('history.back')}
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">
              {feed ? t('history.titleWithName', { name: feed.name }) : t('history.title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('history.subtitle')}
            </p>
          </div>
          <Button onClick={() => void fetchNow()} loading={refreshing}>
            <RefreshCw className="h-4 w-4" /> {t('history.fetchNow')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label={t('history.stat.total')}
          value={counts.total}
          tone="neutral"
          active={status === 'all'}
          onClick={() => setStatus('all')}
        />
        <StatTile
          label={t('history.stat.downloaded')}
          value={counts.downloaded}
          tone="success"
          active={status === 'downloaded'}
          onClick={() => toggleStatus('downloaded')}
        />
        <StatTile
          label={t('history.stat.matched')}
          value={counts.matched}
          tone="info"
          active={status === 'matched'}
          onClick={() => toggleStatus('matched')}
        />
        <StatTile
          label={t('history.stat.seen')}
          value={counts.seen}
          tone="warning"
          active={status === 'seen'}
          onClick={() => toggleStatus('seen')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t('history.filter.searchPlaceholder')}
            aria-label={t('history.filter.search')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            className="w-[150px]"
            aria-label={t('history.filter.from')}
            title={t('history.filter.from')}
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">{t('history.filter.to')}</span>
          <Input
            type="date"
            className="w-[150px]"
            aria-label={t('history.filter.toLabel')}
            title={t('history.filter.toLabel')}
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="whitespace-nowrap">
            <X className="h-4 w-4" /> {t('history.filter.clear')}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <CenteredSpinner label={t('history.loading')} />
            </div>
          ) : isError ? (
            <div className="p-6">
              <ErrorState message={t('history.loadError')} onRetry={() => refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={filtered ? <Search className="h-6 w-6" /> : <History className="h-6 w-6" />}
                title={filtered ? t('history.empty.filteredTitle') : t('history.empty.title')}
                description={
                  filtered ? t('history.empty.filteredDescription') : t('history.empty.description')
                }
                action={
                  filtered ? (
                    <Button variant="outline" size="sm" onClick={clearFilters}>
                      <X className="h-4 w-4" /> {t('history.filter.clear')}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto scrollbar-thin">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[320px] pl-4">{t('history.col.release')}</TableHead>
                      <TableHead className="w-[130px]">{t('history.col.status')}</TableHead>
                      <TableHead className="w-[130px]">{t('history.col.seen')}</TableHead>
                      <TableHead className="w-[260px] pr-4 text-right">{t('history.col.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const status = statusOf(item);
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="pl-4">
                            <p className="break-all font-mono text-xs text-foreground/90">
                              {item.title}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge variant={status.variant} dot>
                              {t(`history.status.${status.key}` as 'history.status.seen')}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {formatRelativeTime(item.createdAt)}
                          </TableCell>
                          <TableCell className="pr-4">
                            <div className="flex items-center justify-end gap-2">
                              {!item.matched && !item.downloaded && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="whitespace-nowrap"
                                  onClick={() => setRuleFor(item)}
                                >
                                  <Wand2 className="h-4 w-4" /> {t('history.createRule')}
                                </Button>
                              )}
                              {!item.downloaded && item.magnet && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="whitespace-nowrap"
                                  onClick={() => void download(item)}
                                  loading={downloadingId === item.id}
                                  disabled={downloadingId !== null}
                                >
                                  <Download className="h-4 w-4" /> {t('history.download')}
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('history.rowsPerPage')}</span>
                  <Select
                    aria-label={t('history.rowsPerPage')}
                    className="h-8 w-[72px]"
                    value={String(pageSize)}
                    onChange={(e) => changePageSize(Number(e.target.value))}
                    options={PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
                  />
                  {isFetching && <span className="opacity-70">{t('history.updating')}</span>}
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-xs text-muted-foreground">
                    {t('history.pageInfo', {
                      count: total,
                      page,
                      totalPages,
                      total: total.toLocaleString(),
                    })}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" /> {t('history.prev')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      {t('history.next')} <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {ruleFor && feed && (
        <QuickRuleDialog
          feed={feed}
          item={ruleFor}
          onClose={() => setRuleFor(null)}
          onCreated={() => {
            setRuleFor(null);
            invalidateHistory();
            queryClient.invalidateQueries({ queryKey: ['rss'] });
          }}
        />
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'success' | 'info' | 'warning';
  active?: boolean;
  onClick?: () => void;
}) {
  const map = {
    neutral: { text: 'text-foreground', bg: '', border: 'border-border/60', ring: 'ring-foreground/40' },
    success: { text: 'text-success', bg: 'bg-success/5', border: 'border-success/30', ring: 'ring-success/50' },
    info: { text: 'text-info', bg: 'bg-info/5', border: 'border-info/30', ring: 'ring-info/50' },
    warning: { text: 'text-warning', bg: 'bg-warning/5', border: 'border-warning/30', ring: 'ring-warning/50' },
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-lg border p-4 text-left transition hover:bg-white/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-0',
        map.bg,
        map.border,
        active && cn('ring-2', map.ring),
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', map.text)}>
        {value.toLocaleString()}
      </p>
    </button>
  );
}

/**
 * Quick "create a rule for this release" flow. Preloads the smart-match
 * analysis of the item's title so the user only has to confirm a name — the
 * pattern, quality, and season/episode are already suggested.
 */
function QuickRuleDialog({
  feed,
  item,
  onClose,
  onCreated,
}: {
  feed: RssFeed;
  item: RssHistoryItem;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation('rss');
  const toast = useToast();
  const [name, setName] = useState('');
  const [autoDownload, setAutoDownload] = useState(true);
  const [saving, setSaving] = useState(false);
  const [touchedName, setTouchedName] = useState(false);

  const { data: analysis, isLoading, isError } = useQuery<SmartAnalyzeResult>({
    queryKey: ['rss', 'analyze', item.title],
    queryFn: () => api.rss.analyzeSmartMatch(item.title),
  });

  // Suggested name = parsed show/movie title, falling back to the raw title.
  const suggestedName = analysis?.parsedMetadata?.title?.trim() || item.title;
  const effectiveName = touchedName ? name : suggestedName;
  const meta = analysis?.parsedMetadata;

  const chips = useMemo(() => {
    if (!meta) return [] as string[];
    const out: string[] = [];
    if (meta.season != null) {
      out.push(
        meta.episode != null
          ? t('quickRule.chip.seasonEpisode', { season: meta.season, episode: meta.episode })
          : t('quickRule.chip.season', { season: meta.season }),
      );
    }
    if (meta.year != null) out.push(String(meta.year));
    if (meta.resolution) out.push(meta.resolution);
    if (meta.source) out.push(meta.source);
    if (meta.codec) out.push(meta.codec);
    return out;
  }, [meta, t]);

  const create = async () => {
    if (!analysis) return;
    const ruleName = effectiveName.trim();
    if (!ruleName) {
      toast.error(t('quickRule.toast.nameRequired'), t('quickRule.toast.nameRequiredBody'));
      return;
    }
    setSaving(true);
    try {
      const rule = await api.rss.createRule({
        feedId: feed.id,
        name: ruleName,
        autoDownload,
      });
      await api.rss.applySmartMatch(rule.id, {
        sourceName: analysis.sourceName,
        parsedMetadata: analysis.parsedMetadata,
        confidenceScore: analysis.confidenceScore,
        recommendedCandidates: analysis.recommendedCandidates,
        userEdited: touchedName,
      });
      toast.success(
        t('quickRule.toast.created'),
        autoDownload
          ? t('quickRule.toast.createdAuto', { name: ruleName })
          : t('quickRule.toast.createdManual', { name: ruleName }),
      );
      onCreated();
    } catch (err) {
      toast.error(t('quickRule.toast.createFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('quickRule.title')}</DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">{item.title}</DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-2">
        {isLoading ? (
          <div className="py-6">
            <CenteredSpinner label={t('quickRule.analyzing')} />
          </div>
        ) : isError || !analysis ? (
          <ErrorState message={t('quickRule.analyzeError')} />
        ) : (
          <>
            <div>
              <Label htmlFor="quick-rule-name">{t('quickRule.nameLabel')}</Label>
              <Input
                id="quick-rule-name"
                value={effectiveName}
                onChange={(e) => {
                  setTouchedName(true);
                  setName(e.target.value);
                }}
                placeholder={t('quickRule.namePlaceholder')}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('quickRule.nameHint')}
              </p>
            </div>

            {chips.length > 0 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" /> {t('quickRule.detected')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {chips.map((c) => (
                    <Badge key={c} variant="secondary">
                      {c}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-md border border-border/60 p-3">
              <p className="text-sm font-medium">{t('quickRule.matchPreferences')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('quickRule.candidatesInfo', { count: analysis.recommendedCandidates.length })}
              </p>
              <ol className="mt-2 space-y-1">
                {analysis.recommendedCandidates.slice(0, 4).map((c, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">{i + 1}.</span>
                    <span className="font-medium">{c.name}</span>
                    {c.pattern && (
                      <span className="truncate font-mono text-muted-foreground">{c.pattern}</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
              <div>
                <Label htmlFor="quick-rule-auto" className="cursor-pointer">
                  {t('quickRule.autoDownload')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('quickRule.autoDownloadHint')}
                </p>
              </div>
              <Switch id="quick-rule-auto" checked={autoDownload} onCheckedChange={setAutoDownload} />
            </div>
          </>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('quickRule.cancel')}
        </Button>
        <Button
          onClick={() => void create()}
          loading={saving}
          disabled={isLoading || isError || !analysis}
        >
          {saving ? (
            <>
              <Spinner className="h-4 w-4" /> {t('quickRule.creating')}
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" /> {t('quickRule.create')}
            </>
          )}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
