import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  RefreshCw,
  Sparkles,
  Wand2,
} from 'lucide-react';
import {
  ApiError,
  api,
  type RssFeed,
  type RssHistoryItem,
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

function statusOf(item: RssHistoryItem): { label: string; variant: StatusTone } {
  if (item.downloaded) return { label: 'Downloaded', variant: 'success' };
  if (item.matched) return { label: 'Matched', variant: 'info' };
  return { label: 'Seen', variant: 'warning' };
}

export function RssFeedHistoryPage() {
  const { feedId = '' } = useParams<{ feedId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [ruleFor, setRuleFor] = useState<RssHistoryItem | null>(null);

  const feedsQuery = useQuery({ queryKey: ['rss'], queryFn: api.rss.list });
  const feed = feedsQuery.data?.find((f) => f.id === feedId);

  const historyKey = ['rss', 'history', feedId, page, pageSize];
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: historyKey,
    queryFn: () => api.rss.history(feedId, { page, pageSize }),
    enabled: !!feedId,
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts ?? { downloaded: 0, matched: 0, seen: 0 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const invalidateHistory = () =>
    queryClient.invalidateQueries({ queryKey: ['rss', 'history', feedId] });

  const fetchNow = async () => {
    setRefreshing(true);
    try {
      const { newItems, downloaded } = await api.rss.refreshFeed(feedId);
      toast.success(
        'Feed fetched',
        newItems === 0
          ? 'No new items.'
          : `${newItems} new item${newItems === 1 ? '' : 's'}` +
              (downloaded > 0 ? `, ${downloaded} downloaded` : ''),
      );
      invalidateHistory();
    } catch (err) {
      toast.error('Could not fetch feed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setRefreshing(false);
    }
  };

  const download = async (item: RssHistoryItem) => {
    setDownloadingId(item.id);
    try {
      await api.rss.downloadHistoryItem(item.id);
      toast.success('Download started', item.title);
      invalidateHistory();
    } catch (err) {
      toast.error('Download failed', err instanceof ApiError ? err.message : undefined);
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
          <ArrowLeft className="h-4 w-4" /> Back to RSS
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">
              Feed history{feed ? ` — ${feed.name}` : ''}
            </h1>
            <p className="text-sm text-muted-foreground">
              Every release this feed has delivered, newest first. Create a rule on
              anything not yet matched to start grabbing it automatically.
            </p>
          </div>
          <Button onClick={() => void fetchNow()} loading={refreshing}>
            <RefreshCw className="h-4 w-4" /> Fetch now
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total" value={total} tone="neutral" />
        <StatTile label="Downloaded" value={counts.downloaded} tone="success" />
        <StatTile label="Matched" value={counts.matched} tone="info" />
        <StatTile label="Seen" value={counts.seen} tone="warning" />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <CenteredSpinner label="Loading history…" />
            </div>
          ) : isError ? (
            <div className="p-6">
              <ErrorState message="Could not load feed history." onRetry={() => refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<History className="h-6 w-6" />}
                title="No history yet"
                description="Items appear here after the feed is fetched. Use “Fetch now” to pull it immediately."
              />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto scrollbar-thin">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[320px] pl-4">Release</TableHead>
                      <TableHead className="w-[130px]">Status</TableHead>
                      <TableHead className="w-[130px]">Seen</TableHead>
                      <TableHead className="w-[260px] pr-4 text-right">Actions</TableHead>
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
                              {status.label}
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
                                  <Wand2 className="h-4 w-4" /> Create rule
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
                                  <Download className="h-4 w-4" /> Download
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
                  <span>Rows per page</span>
                  <Select
                    aria-label="Rows per page"
                    className="h-8 w-[72px]"
                    value={String(pageSize)}
                    onChange={(e) => changePageSize(Number(e.target.value))}
                    options={PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
                  />
                  {isFetching && <span className="opacity-70">updating…</span>}
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-xs text-muted-foreground">
                    Page {page} of {totalPages} · {total.toLocaleString()} item
                    {total === 1 ? '' : 's'}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" /> Prev
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next <ChevronRight className="h-4 w-4" />
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
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'success' | 'info' | 'warning';
}) {
  const map = {
    neutral: { text: 'text-foreground', bg: '', border: 'border-border/60' },
    success: { text: 'text-success', bg: 'bg-success/5', border: 'border-success/30' },
    info: { text: 'text-info', bg: 'bg-info/5', border: 'border-info/30' },
    warning: { text: 'text-warning', bg: 'bg-warning/5', border: 'border-warning/30' },
  }[tone];
  return (
    <div className={cn('rounded-lg border p-4', map.bg, map.border)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', map.text)}>
        {value.toLocaleString()}
      </p>
    </div>
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
      out.push(meta.episode != null ? `S${meta.season} · E${meta.episode}` : `Season ${meta.season}`);
    }
    if (meta.year != null) out.push(String(meta.year));
    if (meta.resolution) out.push(meta.resolution);
    if (meta.source) out.push(meta.source);
    if (meta.codec) out.push(meta.codec);
    return out;
  }, [meta]);

  const create = async () => {
    if (!analysis) return;
    const ruleName = effectiveName.trim();
    if (!ruleName) {
      toast.error('Name required', 'Give the rule a name.');
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
        'Rule created',
        autoDownload
          ? `“${ruleName}” — matching releases in history are being grabbed.`
          : `“${ruleName}” created.`,
      );
      onCreated();
    } catch (err) {
      toast.error('Could not create rule', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>Create rule from this release</DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">{item.title}</DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-2">
        {isLoading ? (
          <div className="py-6">
            <CenteredSpinner label="Analyzing release…" />
          </div>
        ) : isError || !analysis ? (
          <ErrorState message="Could not analyze this release." />
        ) : (
          <>
            <div>
              <Label htmlFor="quick-rule-name">Rule name</Label>
              <Input
                id="quick-rule-name"
                value={effectiveName}
                onChange={(e) => {
                  setTouchedName(true);
                  setName(e.target.value);
                }}
                placeholder="e.g. Agent Kim Reactivated"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Pre-filled from the release. Edit if you want a broader or narrower rule.
              </p>
            </div>

            {chips.length > 0 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" /> Detected
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
              <p className="text-sm font-medium">Match preferences</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {analysis.recommendedCandidates.length} candidate
                {analysis.recommendedCandidates.length === 1 ? '' : 's'} will be created
                (best-quality first). You can fine-tune them later under Match preferences.
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
                  Auto-download matches
                </Label>
                <p className="text-xs text-muted-foreground">
                  Grab this release now and future matches automatically.
                </p>
              </div>
              <Switch id="quick-rule-auto" checked={autoDownload} onCheckedChange={setAutoDownload} />
            </div>
          </>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => void create()}
          loading={saving}
          disabled={isLoading || isError || !analysis}
        >
          {saving ? (
            <>
              <Spinner className="h-4 w-4" /> Creating…
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" /> Create rule &amp; grab matches
            </>
          )}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
