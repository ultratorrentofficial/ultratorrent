import { useEffect } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Radio, Users, Activity, Cpu, MonitorPlay } from 'lucide-react';
import { api, type MediaServerLiveSession } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { useRealtime } from '@/realtime/RealtimeContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { KpiTile } from './analytics-widgets';
import {
  PlaybackArtwork, PlaybackAvatar, PlaybackProgress, PlaybackStateBadge,
} from '@/components/playback/PlaybackPrimitives';
import { accentForPlaybackState } from '@/components/playback/playback-tokens';
import { avatarFor, formatMediaLabel } from '@ultratorrent/shared';
import { PLAYBACK_COLORS } from './analytics-colors';

/** Normalize the many provider spellings of a playback method into four buckets. */
function methodKey(m: string | null): 'directplay' | 'directstream' | 'transcode' | 'other' {
  const v = (m ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (v.includes('transcode')) return 'transcode';
  if (v.includes('directstream') || v.includes('copy')) return 'directstream';
  if (v.includes('directplay') || v === 'direct') return 'directplay';
  return 'other';
}
const methodColor = (m: string | null) => PLAYBACK_COLORS[methodKey(m) === 'other' ? 'unknown' : methodKey(m)];
const mbps = (kbps: number | null) => (kbps && kbps > 0 ? `${(kbps / 1000).toFixed(1)} Mbps` : null);

export function LiveActivityPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const qc = useQueryClient();
  const { status } = useRealtime();

  const q = useQuery({
    queryKey: ['mediaServerAnalytics', 'live'],
    queryFn: () => api.mediaServerAnalytics.live(),
    refetchInterval: 8000,
  });

  // Push updates: the poller broadcasts session lifecycle events — refetch on them.
  useEffect(() => {
    const refetch = () => void qc.invalidateQueries({ queryKey: ['mediaServerAnalytics', 'live'] });
    const offs = [
      wsClient.on('media_server.session.started', refetch),
      wsClient.on('media_server.session.ended', refetch),
    ];
    return () => offs.forEach((off) => off());
  }, [qc]);

  const sessions = q.data ?? [];
  const live = status === 'connected';

  // Summary metrics.
  // Counted on the resolved name so one person streaming under their handle on
  // one client and their account on another is one watcher, not two.
  const watchers = new Set(sessions.map((s) => s.userDisplayName ?? s.userName).filter(Boolean)).size;
  const totalKbps = sessions.reduce((sum, s) => sum + (s.bitrateKbps ?? 0), 0);
  const transcodes = sessions.filter((s) => methodKey(s.playbackMethod) === 'transcode').length;

  // Stream-mix segments (proportion bar), grouped by playback method.
  const mix = (['directplay', 'directstream', 'transcode', 'other'] as const)
    .map((key) => ({ key, count: sessions.filter((s) => methodKey(s.playbackMethod) === key).length }))
    .filter((seg) => seg.count > 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('liveActivity.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('liveActivity.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <span className={cn('relative flex h-2 w-2', live && 'animate-pulse')}>
              <span className={cn('h-2 w-2 rounded-full', live ? 'bg-success' : 'bg-muted-foreground')} />
            </span>
            <span className={live ? 'text-success' : 'text-muted-foreground'}>
              {live ? t('liveActivity.liveLabel') : t('liveActivity.reconnecting')}
            </span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={q.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {t('liveActivity.refresh')}
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <CenteredSpinner />
      ) : q.isError ? (
        <ErrorState title={t('liveActivity.loadError')} onRetry={() => void q.refetch()} />
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <MonitorPlay className="h-8 w-8 text-muted-foreground/50" />
            <EmptyState title={t('liveActivity.empty')} />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile icon={Radio} value={String(sessions.length)} label={t('liveActivity.kpi.streams')} tone="text-info" />
            <KpiTile icon={Users} value={String(watchers)} label={t('liveActivity.kpi.watchers')} tone="text-success" />
            <KpiTile icon={Activity} value={mbps(totalKbps) ?? '—'} label={t('liveActivity.kpi.bandwidth')} tone="text-warning" />
            <KpiTile icon={Cpu} value={String(transcodes)} label={t('liveActivity.kpi.transcodes')} tone="text-warning" />
          </div>

          {/* Stream mix */}
          {mix.length > 0 && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <h3 className="text-xs font-semibold text-muted-foreground">{t('liveActivity.streamMix')}</h3>
                <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.04]">
                  {mix.map((seg) => (
                    <div
                      key={seg.key}
                      style={{ width: `${(seg.count / sessions.length) * 100}%`, background: PLAYBACK_COLORS[seg.key === 'other' ? 'unknown' : seg.key] }}
                      className="h-full border-r-2 border-[hsl(240_22%_7%)] last:border-r-0"
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {mix.map((seg) => (
                    <span key={seg.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="h-2 w-2 rounded-full" style={{ background: PLAYBACK_COLORS[seg.key === 'other' ? 'unknown' : seg.key] }} />
                      {t(`playbackMethods.${seg.key}`)} · {seg.count}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Session cards */}
          <div className="grid gap-3 lg:grid-cols-2">
            {sessions.map((s) => (
              <SessionCard key={s.id} s={s} t={t} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SessionCard({ s, t }: { s: MediaServerLiveSession; t: TFunction<'mediaServerAnalytics'> }) {
  const color = methodColor(s.playbackMethod);
  const paused = s.playbackState === 'paused';
  // Derived through the SAME helpers the notification card uses, so a live card
  // and a playback notification cannot describe the same session differently.
  const state = accentForPlaybackState(s.playbackState);
  // Initials must come from the shown name, or "Jane Smith" gets a `j` avatar.
  const viewer = s.userDisplayName ?? s.userName;
  const avatar = avatarFor(viewer);
  const mediaLabel = formatMediaLabel({
    title: s.title,
    showTitle: s.showTitle,
    seasonNumber: s.seasonNumber,
    episodeNumber: s.episodeNumber,
    year: s.year,
  });
  const chips = [s.resolution, s.videoCodec?.toUpperCase(), mbps(s.bitrateKbps), s.container?.toUpperCase()].filter(Boolean) as string[];

  return (
    <Card className="overflow-hidden">
      <div className="flex">
        <div className="w-1 shrink-0" style={{ background: color }} />
        <div className="flex min-w-0 flex-1 gap-3 p-3">
          {s.hasArtwork ? (
            <PlaybackArtwork
              artwork={{
                kind: 'session',
                id: s.id,
                aspect: 'poster',
                alt: mediaLabel,
                mediaType: s.mediaType,
              }}
              className="h-[112px] w-[75px] shrink-0 ring-1 ring-white/10"
            />
          ) : (
            <div className="h-[112px] w-[75px] shrink-0 rounded-lg border border-white/5 bg-white/[0.04]" aria-hidden="true" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 truncate font-medium leading-tight" title={mediaLabel}>
                {mediaLabel}
              </span>
              <PlaybackStateBadge
                label={t(`liveActivity.state.${paused ? 'paused' : 'playing'}`)}
                accent={state.accent}
                icon={state.icon}
              />
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {avatar && <PlaybackAvatar avatar={avatar} accent={state.accent} size="sm" />}
              {viewer && <span className="font-medium text-foreground/80">{viewer}</span>}
              {s.device && <span>· {s.device}</span>}
              {s.libraryName && <span>· {s.libraryName}</span>}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: `${color}22`, color }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                {t(`playbackMethods.${methodKey(s.playbackMethod)}`)}
              </span>
              {chips.map((c) => (
                <span key={c} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-muted-foreground">{c}</span>
              ))}
            </div>

            {s.progressPercent != null && (
              <div className="mt-auto">
                <PlaybackProgress
                  progress={{
                    percent: Math.round(s.progressPercent),
                    label: `${Math.round(s.progressPercent)}%`,
                    positionLabel: null,
                  }}
                  accent={state.accent}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
