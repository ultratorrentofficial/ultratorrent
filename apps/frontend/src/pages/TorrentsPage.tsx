import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

const STATE_FILTERS: { value: string; key: string }[] = [
  { value: 'all', key: 'all' },
  { value: TorrentState.DOWNLOADING, key: 'downloading' },
  { value: TorrentState.SEEDING, key: 'seeding' },
  { value: TorrentState.COMPLETED, key: 'completed' },
  { value: TorrentState.PAUSED, key: 'paused' },
  { value: TorrentState.ERROR, key: 'error' },
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
  const { t } = useTranslation('torrents');
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
          <h1 className="text-2xl font-bold tracking-tight">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {total > 0 ? t('page.total', { total: total.toLocaleString() }) : t('page.subtitle')}
          </p>
        </div>
        {hasPermission(PERMISSIONS.TORRENTS_ADD) && (
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> {t('addTorrent')}
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
            placeholder={t('search.placeholder')}
            className="pl-9"
            aria-label={t('search.aria')}
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
              {t(`filter.${filter.key}` as 'filter.all')}
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
            title={t('noEngine.title')}
            description={t('noEngine.description')}
            action={
              hasPermission(PERMISSIONS.ENGINES_MANAGE) ? (
                <Button onClick={() => navigate('/engines')}>
                  <Cpu className="h-4 w-4" /> {t('noEngine.action')}
                </Button>
              ) : undefined
            }
          />
        ) : isError ? (
          <ErrorState message={t('loadError')} onRetry={() => refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-6 w-6" />}
            title={t('empty.title')}
            description={
              search || stateFilter !== 'all'
                ? t('empty.searchDescription')
                : t('empty.description')
            }
            action={
              hasPermission(PERMISSIONS.TORRENTS_ADD) && !search && stateFilter === 'all' ? (
                <Button onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" /> {t('addTorrent')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            {/*
              `table-fixed` + a width on every column but Name is what keeps this table
              still. Under the browser's default auto layout the columns are re-measured
              from their content on every poll, so a rate flipping between "—" and
              "1.2 MB/s" visibly shifts the whole table a few times a second. Fixed layout
              takes the widths from the header row and ignores the cells entirely.

              `whitespace-nowrap` is set once here and inherits into every cell: nothing in
              this table may wrap, because a wrapped cell is a two-line row among one-line
              rows. Overlong content truncates instead (see the Name and Added cells) and
              the table scrolls sideways inside the wrapper above rather than reflowing.

              The widths hold the LONGEST header across locales, not the English one —
              es-PR's "Progreso"/"Semillas"/"Agregado" are all wider than their English
              counterparts, and sizing to English alone clips them.
            */}
            <Table className="min-w-[1560px] table-fixed whitespace-nowrap">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-4">
                    <Checkbox
                      checked={allOnPageSelected}
                      indeterminate={!allOnPageSelected && someOnPageSelected}
                      onCheckedChange={toggleAll}
                      aria-label={t('table.selectAll')}
                    />
                  </TableHead>
                  {/* w-12 was too narrow for the header word itself ("Status"/"Estado"). */}
                  <TableHead className="w-20">{t('col.status')}</TableHead>
                  <SortableHead sortKey="name" activeKey={sortBy} direction={sortDir} onSort={handleSort}>
                    {t('col.name')}
                  </SortableHead>
                  <SortableHead sortKey="progress" activeKey={sortBy} direction={sortDir} onSort={handleSort} className="w-40">
                    {t('col.progress')}
                  </SortableHead>
                  <SortableHead sortKey="size" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-24">
                    {t('col.size')}
                  </SortableHead>
                  <SortableHead sortKey="downloadRate" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-28">
                    {t('col.down')}
                  </SortableHead>
                  <SortableHead sortKey="uploadRate" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-28">
                    {t('col.up')}
                  </SortableHead>
                  <SortableHead sortKey="ratio" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-24">
                    {t('col.ratio')}
                  </SortableHead>
                  <SortableHead sortKey="eta" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-28">
                    {t('col.eta')}
                  </SortableHead>
                  <SortableHead sortKey="seedsConnected" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-28">
                    {t('col.seeds')}
                  </SortableHead>
                  <SortableHead sortKey="peersConnected" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-24">
                    {t('col.peers')}
                  </SortableHead>
                  <SortableHead sortKey="downloaded" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-24">
                    {t('col.dl')}
                  </SortableHead>
                  <SortableHead sortKey="uploaded" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-24">
                    {t('col.ul')}
                  </SortableHead>
                  <SortableHead sortKey="addedAt" activeKey={sortBy} direction={sortDir} onSort={handleSort} align="right" className="w-28 pr-4">
                    {t('col.added')}
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
            {t('pagination.page', { page, total: totalPages })}
            {isFetching && <span className="ml-2 opacity-70">{t('pagination.updating')}</span>}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" /> {t('pagination.prev')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t('pagination.next')} <ChevronRight className="h-4 w-4" />
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
  const { t } = useTranslation('torrents');
  return (
    <TableRow selected={selected} className="cursor-pointer" onClick={onOpen}>
      <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={t('table.selectRow', { name: torrent.name })} />
      </TableCell>
      <TableCell>
        <TorrentStateDot state={torrent.state} />
      </TableCell>
      {/*
        Name and label share ONE line. Stacking the label underneath made a labelled row
        taller than an unlabelled one, which is most of the row-height jitter — with a
        live-updating list you see it as the rows breathing. min-w-0 is what lets the name
        actually truncate: a flex child defaults to min-width:auto and would otherwise
        refuse to shrink below its text, pushing the column wide.
      */}
      <TableCell>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium text-foreground" title={torrent.name}>
            {torrent.name}
          </span>
          {torrent.label && (
            <span
              className="max-w-[120px] shrink-0 truncate rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={torrent.label}
            >
              {torrent.label}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        {/* Bar + pct must fit w-40 (160px) minus px-3 padding: 80 + 8 + 40 = 128. */}
        <div className="flex items-center gap-2">
          <Progress value={torrent.progress} className="h-1.5 w-20" />
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
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
      {/* Relative time is open-ended ("hace 2 meses") — truncate rather than overflow. */}
      <TableCell
        className="truncate pr-4 text-right text-xs tabular-nums text-muted-foreground"
        title={formatRelativeTime(torrent.addedAt)}
      >
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

