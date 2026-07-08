import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type LibrarySeries } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { ShowStatusBadge } from '@/components/rss/ShowStatusPanel';

/**
 * Multi-select picker that lists the TV series already in the media libraries so
 * the user can bulk-add them to the missing-episodes watchlist — instead of
 * hand-typing each title + IMDb id. Shows-already-monitored are pre-checked and
 * locked; shows with no resolvable IMDb id are flagged (addable, but not
 * scannable until identified).
 */
export function AddSeriesFromLibraryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ['media-acquisition', 'librarySeries'],
    queryFn: () => api.mediaAcquisition.librarySeries(),
    enabled: open,
  });

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const q = search.trim().toLowerCase();
    return q ? all.filter((r) => r.title.toLowerCase().includes(q)) : all;
  }, [query.data, search]);

  const addable = rows.filter((r) => !r.onWatchlist);
  const toggle = (title: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(title) ? next.delete(title) : next.add(title);
      return next;
    });

  const add = useMutation({
    mutationFn: () => {
      const chosen = (query.data ?? []).filter((r) => selected.has(r.title));
      return api.mediaAcquisition.bulkAddWatchlist(
        chosen.map((r) => ({ title: r.title, year: r.year, imdbId: r.imdbId })),
      );
    },
    onSuccess: (r) => {
      toast.success(t('acquisition.librarySeries.added', { added: r.added, skipped: r.skipped }));
      void queryClient.invalidateQueries({ queryKey: ['media-acquisition'] });
      void queryClient.invalidateQueries({ queryKey: ['acquisition', 'missing-episodes'] });
      setSelected(new Set());
      onClose();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.librarySeries.addFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('acquisition.librarySeries.title')}>
      <p className="text-sm text-muted-foreground">{t('acquisition.librarySeries.subtitle')}</p>

      <div className="mt-3 flex items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('acquisition.librarySeries.search')}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={addable.length === 0}
          onClick={() => setSelected(new Set(addable.map((r) => r.title)))}
        >
          {t('acquisition.librarySeries.selectAll')}
        </Button>
        <Button variant="ghost" size="sm" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
          {t('acquisition.librarySeries.clear')}
        </Button>
      </div>

      <div className="mt-3 max-h-[50vh] overflow-y-auto rounded-md border border-border/60">
        {query.isLoading ? (
          <CenteredSpinner label={t('acquisition.librarySeries.loading')} />
        ) : query.isError ? (
          <ErrorState message={t('acquisition.librarySeries.loadError')} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t('acquisition.librarySeries.empty')} />
        ) : (
          rows.map((r: LibrarySeries) => (
            <label
              key={r.title}
              className="flex cursor-pointer items-center gap-3 border-b border-border/40 px-3 py-2 last:border-0 hover:bg-white/[0.02]"
            >
              <Checkbox
                checked={r.onWatchlist || selected.has(r.title)}
                disabled={r.onWatchlist}
                onCheckedChange={() => toggle(r.title)}
                aria-label={r.title}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{r.title}</span>
                  {r.year != null && <span className="text-xs text-muted-foreground">({r.year})</span>}
                  {r.showStatus && <ShowStatusBadge status={r.showStatus} />}
                  {r.onWatchlist && <Badge variant="success" dot>{t('acquisition.librarySeries.onWatchlist')}</Badge>}
                  {!r.monitorable && !r.onWatchlist && (
                    <Badge variant="warning">{t('acquisition.librarySeries.noImdb')}</Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {t('acquisition.librarySeries.episodes', { count: r.episodeCount })}
                </span>
              </div>
            </label>
          ))
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('acquisition.librarySeries.cancel')}
        </Button>
        <Button onClick={() => add.mutate()} loading={add.isPending} disabled={selected.size === 0}>
          {t('acquisition.librarySeries.add', { count: selected.size })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
