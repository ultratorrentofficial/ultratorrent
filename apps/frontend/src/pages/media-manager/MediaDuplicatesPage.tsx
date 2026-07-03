import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ScanSearch, Star } from 'lucide-react';
import { ApiError, api, type MediaDuplicateGroup } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

export function MediaDuplicatesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'duplicates'],
    queryFn: api.media.listDuplicates,
  });

  const detect = useMutation({
    mutationFn: api.media.detectDuplicates,
    onSuccess: (groups) => {
      toast.success('Detection complete', `${groups.length} duplicate group(s) found.`);
      queryClient.setQueryData(['media', 'duplicates'], groups);
    },
    onError: (err) => toast.error('Detection failed', err instanceof ApiError ? err.message : undefined),
  });

  const groups = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
            Media Manager
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Duplicates</h1>
          <p className="text-sm text-muted-foreground">
            Groups of items that look like duplicates. The highest-quality item is suggested to keep.
          </p>
        </div>
        <Button variant="secondary" onClick={() => detect.mutate()} loading={detect.isPending}>
          <ScanSearch className="h-4 w-4" /> Detect duplicates
        </Button>
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading duplicates…" />
      ) : isError ? (
        <ErrorState message="Could not load duplicates." onRetry={() => refetch()} />
      ) : groups.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Copy className="h-6 w-6" />}
              title="No duplicates"
              description="Run detection to scan your libraries for duplicate items."
              action={
                <Button variant="secondary" onClick={() => detect.mutate()} loading={detect.isPending}>
                  <ScanSearch className="h-4 w-4" /> Detect duplicates
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <DuplicateGroupCard key={group.id} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

function DuplicateGroupCard({ group }: { group: MediaDuplicateGroup }) {
  const navigate = useNavigate();
  // Client-side keep/remove marking (no destructive backend action exists).
  const [keepId, setKeepId] = useState<string | null>(group.suggestedKeepId);
  const title = useMemo(() => group.items[0]?.title ?? 'Duplicate group', [group.items]);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{title}</p>
          <Badge variant="info">{duplicateReasonLabel(group.reason)}</Badge>
          <span className="text-xs text-muted-foreground">{group.items.length} items</span>
        </div>

        <div className="overflow-x-auto scrollbar-thin">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[240px] pl-4">Item</TableHead>
                <TableHead className="w-[90px]">Year</TableHead>
                <TableHead className="w-[110px]">S/E</TableHead>
                <TableHead className="w-[110px]">Resolution</TableHead>
                <TableHead className="w-[90px]">Codec</TableHead>
                <TableHead className="w-[100px]">Size</TableHead>
                <TableHead className="w-[200px] pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.items.map((item) => {
                const isKeep = keepId === item.id;
                return (
                  <TableRow key={item.id} className={isKeep ? '' : keepId ? 'opacity-60' : ''}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2">
                        {item.id === group.suggestedKeepId && (
                          <Star className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Suggested keep" />
                        )}
                        <button
                          className="text-left font-medium hover:underline"
                          onClick={() => navigate(`/media/items/${item.id}`)}
                        >
                          {item.title}
                        </button>
                      </div>
                      <p className="truncate font-mono text-xs text-muted-foreground">{item.path}</p>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{item.year ?? '—'}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {seasonEpisodeLabel(item.season, item.episode)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{item.bestResolution ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{item.bestCodec ?? '—'}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatBytes(item.totalSize)}
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-2">
                        {isKeep ? (
                          <Badge variant="success">Keep</Badge>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" onClick={() => setKeepId(item.id)}>
                              Keep this
                            </Button>
                            {keepId && <Badge variant="warning">Remove</Badge>}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          Selecting a keeper marks the rest as removal candidates. Remove files from disk via the
          rename engine or your media server.
        </p>
      </CardContent>
    </Card>
  );
}
