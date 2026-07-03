import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clapperboard,
  FolderTree,
  Image,
  Layers,
  ListChecks,
  RefreshCw,
  Sparkles,
  Subtitles,
  TriangleAlert,
} from 'lucide-react';
import { ApiError, api, type MediaDashboardLibrary } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { kindLabel, mediaTypeLabel } from './constants';

type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'destructive';

const TONE_MAP: Record<Tone, { text: string; bg: string; border: string }> = {
  neutral: { text: 'text-foreground', bg: '', border: 'border-border/60' },
  success: { text: 'text-success', bg: 'bg-success/5', border: 'border-success/30' },
  info: { text: 'text-info', bg: 'bg-info/5', border: 'border-info/30' },
  warning: { text: 'text-warning', bg: 'bg-warning/5', border: 'border-warning/30' },
  destructive: { text: 'text-destructive', bg: 'bg-destructive/5', border: 'border-destructive/30' },
};

export function MediaDashboardPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scanning, setScanning] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'dashboard'],
    queryFn: api.media.dashboard,
  });

  const scanAll = async () => {
    const libs = (data?.libraries ?? []).filter((l) => l.isEnabled);
    if (libs.length === 0) {
      toast.info('Nothing to scan', 'No enabled libraries.');
      return;
    }
    setScanning(true);
    let scanned = 0;
    let added = 0;
    let updated = 0;
    try {
      for (const lib of libs) {
        const res = await api.media.scanLibrary(lib.id);
        scanned += res.scanned;
        added += res.added;
        updated += res.updated;
      }
      toast.success(
        'Scan complete',
        `${scanned} scanned · ${added} added · ${updated} updated across ${libs.length} librar${libs.length === 1 ? 'y' : 'ies'}.`,
      );
      queryClient.invalidateQueries({ queryKey: ['media'] });
    } catch (err) {
      toast.error('Scan failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Media Manager</h1>
          <p className="text-sm text-muted-foreground">
            Library health and composition at a glance. Scan, identify, and organise your media.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate('/media/libraries')}>
            <FolderTree className="h-4 w-4" /> Libraries
          </Button>
          <Button variant="outline" onClick={() => navigate('/media/rename')}>
            <Clapperboard className="h-4 w-4" /> Rename tools
          </Button>
          <Button onClick={() => void scanAll()} loading={scanning} disabled={isLoading || isError}>
            <RefreshCw className="h-4 w-4" /> Scan all
          </Button>
        </div>
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading dashboard…" />
      ) : isError || !data ? (
        <ErrorState message="Could not load the Media Manager dashboard." onRetry={() => refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <StatTile label="Total items" value={data.health.total} icon={<Clapperboard className="h-4 w-4" />} tone="neutral" />
            <StatTile label="Unmatched" value={data.health.unmatched} icon={<ListChecks className="h-4 w-4" />} tone="warning" to="/media/items?matchStatus=unmatched" />
            <StatTile label="Low confidence" value={data.health.lowConfidence} icon={<TriangleAlert className="h-4 w-4" />} tone="warning" />
            <StatTile label="Recently added" value={data.health.recentlyAdded} icon={<Sparkles className="h-4 w-4" />} tone="info" />
            <StatTile label="Missing artwork" value={data.health.missingArtwork} icon={<Image className="h-4 w-4" />} tone="info" />
            <StatTile label="Missing subtitles" value={data.health.missingSubtitles} icon={<Subtitles className="h-4 w-4" />} tone="info" />
            <StatTile label="Duplicates" value={data.health.duplicateGroups} icon={<Layers className="h-4 w-4" />} tone="warning" />
            <StatTile label="Failed jobs" value={data.health.failedJobs} icon={<TriangleAlert className="h-4 w-4" />} tone="destructive" />
          </div>

          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">By media type</p>
                <Link to="/media/items" className="text-xs text-info hover:underline">
                  View all items
                </Link>
              </div>
              {Object.keys(data.health.byMediaType).length === 0 ? (
                <p className="text-sm text-muted-foreground">No items scanned yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(data.health.byMediaType).map(([type, count]) => (
                    <Link key={type} to={`/media/items?mediaType=${encodeURIComponent(type)}`}>
                      <Badge variant="secondary">
                        {mediaTypeLabel(type)} · {count.toLocaleString()}
                      </Badge>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Libraries</p>
              <Link to="/media/libraries" className="text-xs text-info hover:underline">
                Manage libraries
              </Link>
            </div>
            {data.libraries.length === 0 ? (
              <Card>
                <CardContent>
                  <EmptyState
                    icon={<FolderTree className="h-6 w-6" />}
                    title="No libraries yet"
                    description="Add a library to point Media Manager at a folder and start scanning."
                    action={
                      <Button onClick={() => navigate('/media/libraries')}>
                        <FolderTree className="h-4 w-4" /> Add a library
                      </Button>
                    }
                  />
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.libraries.map((lib) => (
                  <LibraryCard key={lib.id} library={lib} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LibraryCard({ library }: { library: MediaDashboardLibrary }) {
  return (
    <Link to={`/media/items?libraryId=${library.id}`} className="block">
      <Card className="h-full transition-colors hover:border-info/50">
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-semibold">{library.name}</p>
            <Badge variant="secondary">{kindLabel(library.kind)}</Badge>
            {!library.isEnabled && <Badge variant="outline">disabled</Badge>}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{library.path}</p>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{library.itemCount.toLocaleString()} item{library.itemCount === 1 ? '' : 's'}</span>
            <span>
              {library.lastScanAt ? `Scanned ${formatRelativeTime(library.lastScanAt)}` : 'Never scanned'}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function StatTile({
  label,
  value,
  tone,
  icon,
  to,
}: {
  label: string;
  value: number;
  tone: Tone;
  icon?: React.ReactNode;
  to?: string;
}) {
  const map = TONE_MAP[tone];
  const body = (
    <div className={cn('rounded-lg border p-4 transition-colors', map.bg, map.border, to && 'hover:border-info/50')}>
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', map.text)}>{value.toLocaleString()}</p>
    </div>
  );
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}
