import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Inbox,
  Plus,
  Search,
} from 'lucide-react';
import { TorrentState, type NormalizedTorrent } from '@ultratorrent/shared';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ApiError, api, type TorrentQuery } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useTorrentStream } from '@/realtime/RealtimeContext';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  formatBytes,
  formatEta,
  formatRatio,
  formatRelativeTime,
  formatSpeed,
} from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { TorrentStateDot } from '@/components/torrents/TorrentStateBadge';
import { TorrentDrawer } from '@/components/torrents/TorrentDrawer';
import { BulkToolbar } from '@/components/torrents/BulkToolbar';
import { AddTorrentDialog } from '@/components/torrents/AddTorrentDialog';

const PAGE_SIZE = 25;

const STATE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: TorrentState.DOWNLOADING, label: 'Downloading' },
  { value: TorrentState.SEEDING, label: 'Seeding' },
  { value: TorrentState.COMPLETED, label: 'Completed' },
  { value: TorrentState.PAUSED, label: 'Paused' },
  { value: TorrentState.ERROR, label: 'Errored' },
];

type SortKey =
  | 'name'
  | 'size'
  | 'progress'
  | 'downloadRate'
  | 'uploadRate'
  | 'ratio'
  | 'eta'
  | 'seedsConnected'
  | 'peersConnected'
  | 'downloaded'
  | 'uploaded'
  | 'addedAt'
  | 'state';

export function TorrentsPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 350);
  // State filter is URL-driven (?state=…) so the sidebar sub-views deep-link
  // into a filtered list; an unknown/absent value falls back to "all".
  const rawState = searchParams.get('state');
  const stateFilter = STATE_FILTERS.some((f) => f.value === rawState) ? (rawState as string) : 'all';
  const [sortBy, setSortBy] = useState<SortKey>('addedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeTorrent, setActiveTorrent] = useState<NormalizedTorrent | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Live overrides keyed by hash, applied on top of the fetched page.
  const [liveMap, setLiveMap] = useState<Record<string, NormalizedTorrent>>({});

  const query: TorrentQuery = useMemo(
    () => ({
      search: search || undefined,
      state: stateFilter === 'all' ? undefined : stateFilter,
      sortBy,
      sortDir,
      page,
      pageSize: PAGE_SIZE,
    }),
    [search, stateFilter, sortBy, sortDir, page],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['torrents', query],
    queryFn: () => api.torrents.list(query),
    placeholderData: keepPreviousData,
    refetchInterval: 10000,
  });

  // A fresh install has no engine yet; surface a helpful call-to-action instead
  // of a generic error so users know to configure one.
  const noEngine =
    isError && error instanceof ApiError && /no torrent engine is configured/i.test(error.message);

  // Reset live overrides whenever a fresh page is fetched so stale rows from a
  // previous filter/page don't leak through.
  useEffect(() => {
    setLiveMap({});
  }, [data]);

  // Merge realtime snapshots into the live override map (only for visible rows).
  useTorrentStream(
    useCallback(
      (incoming: NormalizedTorrent[]) => {
        const visible = new Set((data?.items ?? []).map((t) => t.hash));
        setLiveMap((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const t of incoming) {
            if (visible.has(t.hash)) {
              next[t.hash] = t;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      [data],
    ),
  );

  const rows: NormalizedTorrent[] = useMemo(
    () => (data?.items ?? []).map((t) => liveMap[t.hash] ?? t),
    [data, liveMap],
  );

  // Keep the open drawer in sync with live data.
  const activeLive = activeTorrent ? liveMap[activeTorrent.hash] ?? activeTorrent : null;

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const allOnPageSelected = rows.length > 0 && rows.every((t) => selected.has(t.hash));
  const someOnPageSelected = rows.some((t) => selected.has(t.hash));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const t of rows) next.delete(t.hash);
      } else {
        for (const t of rows) next.add(t.hash);
      }
      return next;
    });
  };

  const toggleOne = (hash: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const handleSort = (key: string) => {
    const k = key as SortKey;
    if (sortBy === k) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(k);
      setSortDir('desc');
    }
    setPage(1);
  };

  // Reset paging + selection whenever the (URL-driven) filter changes, whether
  // via a pill click or a sidebar deep-link landing on this page.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [stateFilter]);

  const changeFilter = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === 'all') next.delete('state');
        else next.set('state', value);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Torrents</h1>
          <p className="text-sm text-muted-foreground">
            {total > 0 ? `${total.toLocaleString()} total` : 'Manage your transfers'}
          </p>
        </div>
        {hasPermission(PERMISSIONS.TORRENTS_ADD) && (
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Add torrent
          </Button>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder="Search torrents…"
            className="pl-9"
            aria-label="Search torrents"
          />
        </div>

        <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin rounded-lg bg-white/[0.04] p-1">
          {STATE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => changeFilter(filter.value)}
              className={cn(
                'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all',
                stateFilter === filter.value
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {selected.size > 0 && <BulkToolbar selected={[...selected]} onClear={() => setSelected(new Set())} />}

      {/* Table */}
      <div className="overflow-hidden rounded-lg glass">
        {isLoading ? (
          <div className="p-4">
            <TableSkeleton />
          </div>
        ) : noEngine ? (
          <EmptyState
            icon={<Cpu className="h-6 w-6" />}
            title="No torrent engine configured"
            description="UltraTorrent needs a torrent engine (e.g. rTorrent) before it can list torrents."
            action={
              hasPermission(PERMISSIONS.ENGINES_MANAGE) ? (
                <Button onClick={() => navigate('/engines')}>
                  <Cpu className="h-4 w-4" /> Configure an engine
                </Button>
              ) : undefined
            }
          />
        ) : isError ? (
          <ErrorState message="Could not load torrents." onRetry={() => refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-6 w-6" />}
            title="No torrents found"
            description={
              search || stateFilter !== 'all'
                ? 'Try adjusting your search or filters.'
                : 'Add your first torrent to get started.'
            }
            action={
              hasPermission(PERMISSIONS.TORRENTS_ADD) && !search && stateFilter === 'all' ? (
                <Button onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" /> Add torrent
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-4">
                    <Checkbox
                      checked={allOnPageSelected}
                      indeterminate={!allOnPageSelected && someOnPageSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all on page"
                    />
                  </TableHead>
                  <TableHead className="w-12">Status</TableHead>
                  <SortableHead sortKey="name" activeKey={sortBy} direction={sortDir} onSort={handleSort} className="min-w-[240px]">
                    Name
                  </SortableHead>
                  <SortableHead sortKey="progress" activeKey={sortBy} direction={sortDir} onSort={handleSort} className="w-40">
                    Progress
                  </SortableHead>
                  <SortableHead sortKey="size" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    Size
                  </SortableHead>
                  <SortableHead sortKey="downloadRate" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    Down
                  </SortableHead>
                  <SortableHead sortKey="uploadRate" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    Up
                  </SortableHead>
                  <SortableHead sortKey="ratio" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    Ratio
                  </SortableHead>
                  <SortableHead sortKey="eta" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    ETA
                  </SortableHead>
                  <SortableHead sortKey="seedsConnected" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    Seeds
                  </SortableHead>
                  <SortableHead sortKey="peersConnected" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    Peers
                  </SortableHead>
                  <SortableHead sortKey="downloaded" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    DL
                  </SortableHead>
                  <SortableHead sortKey="uploaded" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right">
                    UL
                  </SortableHead>
                  <SortableHead sortKey="addedAt" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="pr-4">
                    Added
                  </SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => (
                  <TorrentRow
                    key={t.hash}
                    torrent={t}
                    selected={selected.has(t.hash)}
                    onToggle={() => toggleOne(t.hash)}
                    onOpen={() => setActiveTorrent(t)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
            {isFetching && <span className="ml-2 opacity-70">updating…</span>}
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
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <TorrentDrawer torrent={activeLive} onClose={() => setActiveTorrent(null)} />
      <AddTorrentDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function TorrentRow({
  torrent,
  selected,
  onToggle,
  onOpen,
}: {
  torrent: NormalizedTorrent;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <TableRow selected={selected} className="cursor-pointer" onClick={onOpen}>
      <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${torrent.name}`} />
      </TableCell>
      <TableCell>
        <TorrentStateDot state={torrent.state} />
      </TableCell>
      <TableCell className="max-w-[360px]">
        <p className="truncate font-medium text-foreground" title={torrent.name}>
          {torrent.name}
        </p>
        {torrent.label && (
          <span className="text-xs text-muted-foreground">{torrent.label}</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Progress value={torrent.progress} className="h-1.5 w-24" />
          <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
            {Math.round(Math.max(0, Math.min(1, torrent.progress)) * 100)}%
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatBytes(torrent.size)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <SpeedCell rate={torrent.downloadRate} tone="info" icon={<ArrowDown className="h-3 w-3" />} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <SpeedCell rate={torrent.uploadRate} tone="success" icon={<ArrowUp className="h-3 w-3" />} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatRatio(torrent.ratio)}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {torrent.state === TorrentState.DOWNLOADING ? formatEta(torrent.eta) : '—'}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {torrent.seedsConnected}
        <span className="opacity-50">/{torrent.seedsTotal}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {torrent.peersConnected}
        <span className="opacity-50">/{torrent.peersTotal}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatBytes(torrent.downloaded)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatBytes(torrent.uploaded)}
      </TableCell>
      <TableCell className="pr-4 text-right text-xs tabular-nums text-muted-foreground">
        {formatRelativeTime(torrent.addedAt)}
      </TableCell>
    </TableRow>
  );
}

function SpeedCell({
  rate,
  tone,
  icon,
}: {
  rate: number;
  tone: 'info' | 'success';
  icon: React.ReactNode;
}) {
  if (!rate || rate <= 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-end gap-1',
        tone === 'info' ? 'text-info' : 'text-success',
      )}
    >
      {icon}
      {formatSpeed(rate)}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

