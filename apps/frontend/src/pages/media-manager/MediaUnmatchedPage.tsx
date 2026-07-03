import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RotateCw, Search } from 'lucide-react';
import {
  ApiError,
  api,
  type MediaItem,
  type MediaItemType,
  type MediaManualMatchInput,
} from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
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
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { MEDIA_TYPE_OPTIONS, mediaTypeLabel } from './constants';

export function MediaUnmatchedPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canMatch = hasPermission(PERMISSIONS.MEDIA_MANAGER_MATCH);
  const [matching, setMatching] = useState<MediaItem | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['media', 'items', { matchStatus: 'unmatched' }],
    queryFn: () => api.media.listItems({ matchStatus: 'unmatched' }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['media', 'items'] });

  const reidentify = useMutation({
    mutationFn: (id: string) => api.media.matchItem(id),
    onSuccess: (item) => {
      toast.success('Re-identified', item.title);
      invalidate();
    },
    onError: (err) => toast.error('Could not re-identify', err instanceof ApiError ? err.message : undefined),
  });

  const items = data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          Media Manager
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">Unmatched Items</h1>
        <p className="text-sm text-muted-foreground">
          Items automatic identification could not confidently match. Re-run identification or match
          them manually.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <CenteredSpinner label="Loading unmatched items…" />
            </div>
          ) : isError ? (
            <div className="p-6">
              <ErrorState message="Could not load unmatched items." onRetry={() => refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<CheckCircle2 className="h-6 w-6" />}
                title="Nothing unmatched"
                description="Every scanned item has been matched. Nice."
              />
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[280px] pl-4">Title</TableHead>
                    <TableHead className="w-[120px]">Type</TableHead>
                    <TableHead className="w-[80px]">Year</TableHead>
                    <TableHead className="w-[110px]">Confidence</TableHead>
                    {canMatch && <TableHead className="w-[260px] pr-4 text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="pl-4">
                        <button
                          className="text-left font-medium hover:underline"
                          onClick={() => navigate(`/media/items/${item.id}`)}
                        >
                          {item.title}
                        </button>
                        <p className="truncate font-mono text-xs text-muted-foreground">{item.path}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{mediaTypeLabel(item.mediaType)}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{item.year ?? '—'}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {Math.round((item.confidence ?? 0) * 100)}%
                      </TableCell>
                      {canMatch && (
                        <TableCell className="pr-4">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              className="whitespace-nowrap"
                              onClick={() => reidentify.mutate(item.id)}
                              loading={reidentify.isPending && reidentify.variables === item.id}
                            >
                              <RotateCw className="h-4 w-4" /> Re-identify
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="whitespace-nowrap"
                              onClick={() => setMatching(item)}
                            >
                              <Search className="h-4 w-4" /> Match…
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {items.length.toLocaleString()} unmatched item{items.length === 1 ? '' : 's'}
        {isFetching && <span className="opacity-70"> · updating…</span>}
      </p>

      {matching && (
        <ManualMatchDialog
          item={matching}
          onClose={() => setMatching(null)}
          onMatched={() => {
            setMatching(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function ManualMatchDialog({
  item,
  onClose,
  onMatched,
}: {
  item: MediaItem;
  onClose: () => void;
  onMatched: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(item.title);
  const [type, setType] = useState<MediaItemType>(item.mediaType);
  const [year, setYear] = useState(item.year != null ? String(item.year) : '');
  const [season, setSeason] = useState(item.season != null ? String(item.season) : '');
  const [episode, setEpisode] = useState(item.episode != null ? String(item.episode) : '');

  const match = useMutation({
    mutationFn: () => {
      const body: MediaManualMatchInput = {
        title: title.trim() || undefined,
        mediaType: type,
        year: year.trim() ? Number(year) : null,
        season: season.trim() ? Number(season) : null,
        episode: episode.trim() ? Number(episode) : null,
      };
      return api.media.matchItem(item.id, body);
    },
    onSuccess: (updated) => {
      toast.success('Matched', updated.title);
      onMatched();
    },
    onError: (err) => toast.error('Could not match', err instanceof ApiError ? err.message : undefined),
  });

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Match manually</DialogTitle>
        <DialogDescription>
          Provide the correct identity for this item. It will be marked as manually matched.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="mm-title">Title</Label>
          <Input id="mm-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="mm-type">Type</Label>
            <Select
              id="mm-type"
              value={type}
              onChange={(e) => setType(e.target.value as MediaItemType)}
              options={MEDIA_TYPE_OPTIONS}
            />
          </div>
          <div>
            <Label htmlFor="mm-year">Year</Label>
            <Input id="mm-year" type="number" value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="mm-season">Season</Label>
            <Input id="mm-season" type="number" value={season} onChange={(e) => setSeason(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="mm-episode">Episode</Label>
            <Input id="mm-episode" type="number" value={episode} onChange={(e) => setEpisode(e.target.value)} />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => match.mutate()} loading={match.isPending} disabled={!title.trim()}>
          Match item
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
