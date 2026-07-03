import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FileText,
  FolderOpen,
  Globe,
  Hash,
  Lock,
  Users,
  Wand2,
} from 'lucide-react';
import {
  FilePriority,
  TorrentState,
  type NormalizedFile,
  type NormalizedPeer,
  type NormalizedTorrent,
  type NormalizedTracker,
} from '@ultratorrent/shared';
import { api } from '@/lib/api';
import {
  formatBytes,
  formatDateTime,
  formatEta,
  formatPercent,
  formatRatio,
  formatSpeed,
} from '@/lib/format';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { TorrentStateBadge } from './TorrentStateBadge';
import { TorrentActionsBar } from './TorrentActionsBar';
import { cn } from '@/lib/utils';

export interface TorrentDrawerProps {
  /** The torrent to display (live row data), or null when closed. */
  torrent: NormalizedTorrent | null;
  onClose: () => void;
}

type Tab = 'overview' | 'files' | 'peers' | 'trackers';

export function TorrentDrawer({ torrent, onClose }: TorrentDrawerProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const open = torrent != null;

  return (
    <Drawer open={open} onClose={onClose} title={torrent?.name}>
      {torrent && (
        <>
          <DrawerHeader onClose={onClose}>
            <div className="flex items-center gap-2">
              <TorrentStateBadge state={torrent.state} />
              {torrent.isPrivate && (
                <Badge variant="secondary" className="gap-1">
                  <Lock className="h-3 w-3" /> Private
                </Badge>
              )}
            </div>
            <h2 className="mt-2 break-words text-base font-semibold leading-snug">{torrent.name}</h2>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Hash className="h-3 w-3" />
              <span className="truncate font-mono">{torrent.hash}</span>
            </div>
          </DrawerHeader>

          <DrawerBody className="p-0">
            <div className="px-5 pt-4">
              <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
                <TabsList className="w-full">
                  <TabsTrigger value="overview" className="flex-1">
                    Overview
                  </TabsTrigger>
                  <TabsTrigger value="files" className="flex-1">
                    Files
                  </TabsTrigger>
                  <TabsTrigger value="peers" className="flex-1">
                    Peers
                  </TabsTrigger>
                  <TabsTrigger value="trackers" className="flex-1">
                    Trackers
                  </TabsTrigger>
                </TabsList>

                <div className="py-4">
                  <TabsContent value="overview">
                    <OverviewTab torrent={torrent} />
                  </TabsContent>
                  <TabsContent value="files">
                    <FilesTab hash={torrent.hash} active={tab === 'files'} />
                  </TabsContent>
                  <TabsContent value="peers">
                    <PeersTab hash={torrent.hash} active={tab === 'peers'} />
                  </TabsContent>
                  <TabsContent value="trackers">
                    <TrackersTab hash={torrent.hash} active={tab === 'trackers'} />
                  </TabsContent>
                </div>
              </Tabs>
            </div>
          </DrawerBody>

          <DrawerFooter>
            <TorrentActionsBar torrent={torrent} onDeleted={onClose} />
          </DrawerFooter>
        </>
      )}
    </Drawer>
  );
}

function OverviewTab({ torrent }: { torrent: NormalizedTorrent }) {
  // The matching automation rule (if this torrent was auto-downloaded) is
  // resolved by info-hash from the RSS match evaluations — it isn't part of the
  // live engine data, so fetch it separately.
  const { data: matchedRule } = useQuery({
    queryKey: ['torrent', torrent.hash, 'matched-rule'],
    queryFn: () => api.torrents.matchedRule(torrent.hash),
  });

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Progress</span>
          <span className="font-semibold tabular-nums">{formatPercent(torrent.progress)}</span>
        </div>
        <Progress value={torrent.progress} className="h-2.5" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Download" value={formatSpeed(torrent.downloadRate)} tone="info" />
        <Stat label="Upload" value={formatSpeed(torrent.uploadRate)} tone="success" />
        <Stat label="Downloaded" value={formatBytes(torrent.downloaded)} />
        <Stat label="Uploaded" value={formatBytes(torrent.uploaded)} />
        <Stat label="Size" value={formatBytes(torrent.size)} />
        <Stat label="Ratio" value={formatRatio(torrent.ratio)} />
        <Stat
          label="ETA"
          value={torrent.state === TorrentState.DOWNLOADING ? formatEta(torrent.eta) : '—'}
        />
        <Stat label="Seeds / Peers" value={`${torrent.seedsConnected} / ${torrent.peersConnected}`} />
      </div>

      <div className="space-y-2.5 rounded-lg border border-border/60 bg-white/[0.02] p-4 text-sm">
        <Detail icon={<FolderOpen className="h-4 w-4" />} label="Save path" value={torrent.savePath} mono />
        {torrent.label && <Detail icon={<FileText className="h-4 w-4" />} label="Label" value={torrent.label} />}
        <Detail label="Added" value={formatDateTime(torrent.addedAt)} />
        <Detail label="Completed" value={formatDateTime(torrent.completedAt)} />
        <Detail label="Engine" value={torrent.engineId} mono />
        {matchedRule && (
          <Detail
            icon={<Wand2 className="h-4 w-4" />}
            label="Matched rule"
            value={matchedRule.ruleName}
          />
        )}
      </div>

      {torrent.message && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          {torrent.message}
        </div>
      )}
    </div>
  );
}

function FilesTab({ hash, active }: { hash: string; active: boolean }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['torrent', hash, 'files'],
    queryFn: () => api.torrents.files(hash),
    enabled: active,
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message="Could not load files." onRetry={() => refetch()} />;
  if (!data || data.length === 0)
    return <EmptyState icon={<FileText className="h-6 w-6" />} title="No files" />;

  const priorityLabel: Record<FilePriority, string> = {
    [FilePriority.SKIP]: 'Skip',
    [FilePriority.NORMAL]: 'Normal',
    [FilePriority.HIGH]: 'High',
  };
  const priorityVariant: Record<FilePriority, 'secondary' | 'default' | 'warning'> = {
    [FilePriority.SKIP]: 'secondary',
    [FilePriority.NORMAL]: 'default',
    [FilePriority.HIGH]: 'warning',
  };

  return (
    <ul className="space-y-2">
      {data.map((file: NormalizedFile) => (
        <li key={file.index} className="rounded-lg border border-border/60 bg-white/[0.02] p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 flex-1 break-all text-sm">{file.path}</p>
            <Badge variant={priorityVariant[file.priority]} className="shrink-0">
              {priorityLabel[file.priority]}
            </Badge>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Progress value={file.progress} className="h-1.5" />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatPercent(file.progress, 0)} · {formatBytes(file.size)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PeersTab({ hash, active }: { hash: string; active: boolean }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['torrent', hash, 'peers'],
    queryFn: () => api.torrents.peers(hash),
    enabled: active,
    refetchInterval: active ? 4000 : false,
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message="Could not load peers." onRetry={() => refetch()} />;
  if (!data || data.length === 0)
    return <EmptyState icon={<Users className="h-6 w-6" />} title="No connected peers" />;

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="pb-2 pr-3 font-semibold">Address</th>
            <th className="pb-2 pr-3 font-semibold">Client</th>
            <th className="pb-2 pr-3 text-right font-semibold">Done</th>
            <th className="pb-2 pr-3 text-right font-semibold">Down</th>
            <th className="pb-2 text-right font-semibold">Up</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {data.map((peer: NormalizedPeer, i) => (
            <tr key={`${peer.ip}:${peer.port}:${i}`}>
              <td className="py-2 pr-3 font-mono text-xs">
                <span className="flex items-center gap-1.5">
                  {peer.encrypted && <Lock className="h-3 w-3 text-success" />}
                  {peer.ip}:{peer.port}
                </span>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{peer.client ?? '—'}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatPercent(peer.progress, 0)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-info">{formatSpeed(peer.downloadRate)}</td>
              <td className="py-2 text-right tabular-nums text-success">{formatSpeed(peer.uploadRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackersTab({ hash, active }: { hash: string; active: boolean }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['torrent', hash, 'trackers'],
    queryFn: () => api.torrents.trackers(hash),
    enabled: active,
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message="Could not load trackers." onRetry={() => refetch()} />;
  if (!data || data.length === 0)
    return <EmptyState icon={<Globe className="h-6 w-6" />} title="No trackers" />;

  const statusVariant: Record<NormalizedTracker['status'], 'success' | 'destructive' | 'secondary' | 'info'> = {
    working: 'success',
    enabled: 'info',
    disabled: 'secondary',
    error: 'destructive',
  };

  return (
    <ul className="space-y-2">
      {data.map((tracker: NormalizedTracker, i) => (
        <li key={`${tracker.url}:${i}`} className="rounded-lg border border-border/60 bg-white/[0.02] p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="break-all font-mono text-xs">{tracker.url}</p>
              {tracker.message && (
                <p className="mt-1 text-xs text-muted-foreground">{tracker.message}</p>
              )}
            </div>
            <Badge variant={statusVariant[tracker.status]} className="shrink-0 capitalize">
              {tracker.status}
            </Badge>
          </div>
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span>Tier {tracker.tier}</span>
            <span>Seeders: {tracker.seeders ?? '—'}</span>
            <span>Leechers: {tracker.leechers ?? '—'}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'info' | 'success';
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-white/[0.02] px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-sm font-semibold tabular-nums',
          tone === 'info' && 'text-info',
          tone === 'success' && 'text-success',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Detail({
  icon,
  label,
  value,
  mono,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className={cn('text-right break-all', mono && 'font-mono text-xs')}>{value}</span>
    </div>
  );
}
