import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Radio, Play, Clock, Users, Film, Sparkles, Zap, Cpu, Server,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { KpiTile, ChartCard } from './analytics-widgets';
import { CHART, CHART_SERIES, playbackColor, foldTopN, TREND_METHODS } from './analytics-colors';
import { MediaAnalyticsFilterBar } from './MediaAnalyticsFilterBar';
import { RecentlyAddedStrip } from './RecentlyAddedStrip';
import { ActivityHeatmap } from './ActivityHeatmap';
import { ProviderStatusPanel } from './ProviderStatusPanel';
import { useAnalyticsFilters } from './analytics-filters';

function watchTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** De-duplicate selector options by their label, preserving order. */
function uniqueByLabel(options: { value: string; label: string }[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.label) ? false : (seen.add(o.label), true)));
}

const tooltipStyle = { background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, borderRadius: 8, fontSize: 12 };
const axisTick = { fontSize: 11, fill: CHART.tick };

export function MediaServerAnalyticsDashboardPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const qc = useQueryClient();
  const toast = useToast();
  const { state, set, filter, refreshMs, filterKey } = useAnalyticsFilters();
  const liveRefresh = refreshMs || 15000; // live panel always polls (min 15s)
  const [exporting, setExporting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const dash = useQuery({ queryKey: ['msa', 'dashboard'], queryFn: () => api.mediaServerAnalytics.dashboard(), refetchInterval: refreshMs || false });
  const live = useQuery({ queryKey: ['msa', 'live'], queryFn: () => api.mediaServerAnalytics.live(), refetchInterval: liveRefresh });
  const usage = useQuery({ queryKey: ['msa', 'report', 'usage', filterKey], queryFn: () => api.mediaServerAnalytics.reportUsage(filter), refetchInterval: refreshMs || false });
  const playback = useQuery({ queryKey: ['msa', 'report', 'playback', filterKey], queryFn: () => api.mediaServerAnalytics.reportPlayback(filter), refetchInterval: refreshMs || false });
  const users = useQuery({ queryKey: ['msa', 'report', 'users', filterKey], queryFn: () => api.mediaServerAnalytics.reportUsers(filter), refetchInterval: refreshMs || false });
  const devices = useQuery({ queryKey: ['msa', 'report', 'devices', filterKey], queryFn: () => api.mediaServerAnalytics.reportDevices(filter), refetchInterval: refreshMs || false });
  const topMedia = useQuery({ queryKey: ['msa', 'report', 'top-media', filterKey], queryFn: () => api.mediaServerAnalytics.reportTopMedia(filter), refetchInterval: refreshMs || false });
  const heatmap = useQuery({ queryKey: ['msa', 'report', 'heatmap', filterKey], queryFn: () => api.mediaServerAnalytics.reportHeatmap(filter), refetchInterval: refreshMs || false });
  const trends = useQuery({ queryKey: ['msa', 'report', 'trends', filterKey], queryFn: () => api.mediaServerAnalytics.reportTrends(filter), refetchInterval: refreshMs || false });
  const bandwidth = useQuery({ queryKey: ['msa', 'report', 'bandwidth', filterKey], queryFn: () => api.mediaServerAnalytics.reportBandwidth(filter), refetchInterval: refreshMs || false });
  const resolutions = useQuery({ queryKey: ['msa', 'report', 'resolutions', filterKey], queryFn: () => api.mediaServerAnalytics.reportResolutions(filter), refetchInterval: refreshMs || false });
  const growth = useQuery({ queryKey: ['msa', 'report', 'library-growth', filterKey], queryFn: () => api.mediaServerAnalytics.reportLibraryGrowth(filter), refetchInterval: refreshMs || false });
  const metaLibraries = useQuery({ queryKey: ['msa', 'meta', 'libraries'], queryFn: () => api.mediaServerAnalytics.metaLibraries() });
  const metaUsers = useQuery({ queryKey: ['msa', 'meta', 'users'], queryFn: () => api.mediaServerAnalytics.metaUsers() });

  const isFetching = [dash, live, usage, playback, users, devices, topMedia, heatmap, trends, bandwidth, resolutions, growth].some((q) => q.isFetching);
  const refreshAll = () => void qc.invalidateQueries({ queryKey: ['msa'] });
  const runSync = async () => {
    setSyncing(true);
    try {
      await api.mediaServerAnalytics.runSync();
      await qc.invalidateQueries({ queryKey: ['msa'] });
    } catch {
      toast.error(t('providerStatus.syncFailed'));
    } finally {
      setSyncing(false);
    }
  };

  // Selector options: servers from connections; libraries/users from synced metadata
  // (libraries narrow to the chosen server; names de-duplicated).
  const serverOptions = (dash.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }));
  const libraryOptions = uniqueByLabel(
    (metaLibraries.data ?? [])
      .filter((l) => !state.connectionId || l.connectionId === state.connectionId)
      .map((l) => ({ value: l.name, label: l.name })),
  );
  const userOptions = uniqueByLabel((metaUsers.data ?? []).map((u) => ({ value: u.userName, label: u.userName })));
  const exportCsv = async () => {
    setExporting(true);
    try {
      await api.mediaServerAnalytics.exportWatchHistoryCsv(filter);
    } catch {
      toast.error(t('filters.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  if (dash.isLoading) return <CenteredSpinner />;
  if (dash.isError || !dash.data) return <ErrorState title={t('dashboard.loadError')} onRetry={() => void dash.refetch()} />;

  const k = dash.data.kpis;
  const s = dash.data.servers;

  const methodData = (playback.data?.byMethod ?? []).map((m) => ({ name: m.method, value: m.plays, color: playbackColor(m.method) }));
  const userData = foldTopN(users.data ?? [], 8, (u) => u.userName).map((u) => ({ name: u.name, plays: u.plays }));
  const deviceData = foldTopN((devices.data ?? []).map((d) => ({ ...d })), 6, (d) => d.device).map((d) => ({ name: d.name, plays: d.plays }));
  const resolutionData = resolutions.data ?? [];
  const trendData = trends.data ?? [];
  const growthData = growth.data ?? [];
  const bandwidthData = bandwidth.data ?? [];

  return (
    <div className="space-y-6">
      {/* Hero header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-gradient-to-br from-white/[0.04] to-transparent p-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Server className="h-4 w-4 text-muted-foreground" />
          <Badge variant={s.online > 0 ? 'success' : 'secondary'}>{s.online} {t('dashboard.widget.online')}</Badge>
          {s.offline > 0 && <Badge variant="destructive">{s.offline} {t('dashboard.widget.offline')}</Badge>}
          <span className="text-muted-foreground">/ {s.total}</span>
        </div>
      </div>

      {/* Filters */}
      <MediaAnalyticsFilterBar
        state={state}
        onChange={set}
        onRefresh={refreshAll}
        refreshing={isFetching}
        onExport={() => void exportCsv()}
        exporting={exporting}
        servers={serverOptions}
        libraries={libraryOptions}
        users={userOptions}
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile icon={Radio} value={formatNumber(k.activeStreams)} label={t('kpi.activeStreams')} tone="text-info" />
        <KpiTile icon={Play} value={formatNumber(k.totalPlays)} label={t('kpi.totalPlays')} />
        <KpiTile icon={Clock} value={watchTime(k.totalWatchSeconds)} label={t('kpi.watchTime')} />
        <KpiTile icon={Users} value={formatNumber(k.uniqueUsers)} label={t('kpi.users')} tone="text-success" />
        <KpiTile icon={Film} value={formatNumber(k.mediaItems)} label={t('kpi.mediaItems')} />
        <KpiTile icon={Sparkles} value={formatNumber(k.recentlyAdded7d)} label={t('kpi.recentlyAdded')} />
        <KpiTile icon={Zap} value={`${k.directPlayPct}%`} label={t('kpi.directPlay')} tone="text-success" />
        <KpiTile icon={Cpu} value={`${k.transcodePct}%`} label={t('kpi.transcode')} tone="text-warning" />
      </div>

      {/* Now Playing */}
      <div>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Radio className="h-4 w-4 text-info" />{t('liveActivity.title')}
        </h2>
        {live.isLoading ? (
          <CenteredSpinner />
        ) : !live.data || live.data.length === 0 ? (
          <EmptyState title={t('liveActivity.empty')} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {live.data.map((sess) => (
              <Card key={sess.id}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{sess.title}</span>
                    {sess.playbackMethod && (
                      <span className="flex items-center gap-1.5 text-xs">
                        <span className="h-2 w-2 rounded-full" style={{ background: playbackColor(sess.playbackMethod) }} />
                        {sess.playbackMethod}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {sess.userName && <span>{sess.userName}</span>}
                    {sess.device && <span>· {sess.device}</span>}
                    {sess.resolution && <span>· {sess.resolution}</span>}
                    {sess.videoCodec && <span>· {sess.videoCodec}</span>}
                  </div>
                  {sess.progressPercent != null && <Progress value={sess.progressPercent / 100} />}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Recently added (artwork) */}
      <RecentlyAddedStrip />

      {/* Charts */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title={t('charts.playsOverTime')} loading={usage.isLoading} empty={(usage.data?.byDay.length ?? 0) === 0} emptyLabel={t('reports.empty')}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={usage.data?.byDay ?? []} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="playsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_SERIES[0]} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={CHART_SERIES[0]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: CHART.tooltipLabel }} />
              <Area type="monotone" dataKey="plays" stroke={CHART_SERIES[0]} strokeWidth={2} fill="url(#playsGrad)" name={t('charts.plays')} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('charts.playbackMethod')} loading={playback.isLoading} empty={methodData.length === 0} emptyLabel={t('reports.empty')}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={methodData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2} strokeWidth={0}>
                {methodData.map((d) => <Cell key={d.name} fill={d.color} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('charts.topUsers')} loading={users.isLoading} empty={userData.length === 0} emptyLabel={t('reports.empty')}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={userData} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={axisTick} tickLine={false} axisLine={false} width={90} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: CHART.tooltipLabel }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="plays" fill={CHART_SERIES[0]} radius={[0, 4, 4, 0]} name={t('charts.plays')} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('charts.devices')} loading={devices.isLoading} empty={deviceData.length === 0} emptyLabel={t('reports.empty')}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={deviceData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="name" tick={axisTick} tickLine={false} axisLine={false} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: CHART.tooltipLabel }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="plays" fill={CHART_SERIES[1]} radius={[4, 4, 0, 0]} name={t('charts.plays')} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Streaming trend (transcode vs direct play over time) */}
      <ChartCard title={t('charts.streamTrend')} subtitle={t('charts.streamTrendSub')} loading={trends.isLoading} empty={trendData.length === 0} emptyLabel={t('reports.empty')}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={trendData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <defs>
              {TREND_METHODS.map((m) => (
                <linearGradient key={m.key} id={`trend-${m.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={m.color} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={m.color} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
            <XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: CHART.tooltipLabel }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {TREND_METHODS.map((m) => (
              <Area
                key={m.key}
                type="monotone"
                dataKey={m.key}
                stackId="1"
                stroke={m.color}
                strokeWidth={2}
                fill={`url(#trend-${m.key})`}
                name={t(`playbackMethods.${m.key}`)}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Average bandwidth over time */}
      <ChartCard title={t('charts.bandwidth')} subtitle={t('charts.bandwidthSub')} loading={bandwidth.isLoading} empty={bandwidthData.length === 0} emptyLabel={t('charts.bandwidthEmpty')}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={bandwidthData} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
            <defs>
              <linearGradient id="bwGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_SERIES[2]} stopOpacity={0.4} />
                <stop offset="100%" stopColor={CHART_SERIES[2]} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
            <XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} unit=" Mb" tickFormatter={(v: number) => (v / 1000).toFixed(1)} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: CHART.tooltipLabel }} formatter={(v: number) => [`${(v / 1000).toFixed(2)} Mbps`, t('charts.avgBitrate')]} />
            <Area type="monotone" dataKey="avgKbps" stroke={CHART_SERIES[2]} strokeWidth={2} fill="url(#bwGrad)" name={t('charts.avgBitrate')} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Quality distribution + library growth */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title={t('charts.resolutions')} loading={resolutions.isLoading} empty={resolutionData.length === 0} emptyLabel={t('reports.empty')}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={resolutionData} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="resolution" tick={axisTick} tickLine={false} axisLine={false} width={64} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: CHART.tooltipLabel }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="plays" fill={CHART_SERIES[0]} radius={[0, 4, 4, 0]} name={t('charts.plays')} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('charts.libraryGrowth')} subtitle={t('charts.libraryGrowthSub')} loading={growth.isLoading} empty={growthData.length === 0} emptyLabel={t('reports.empty')}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={growthData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="growthGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_SERIES[1]} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={CHART_SERIES[1]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} axisLine={false} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: CHART.tooltipLabel }} />
              <Area type="monotone" dataKey="total" stroke={CHART_SERIES[1]} strokeWidth={2} fill="url(#growthGrad)" name={t('charts.libraryTotal')} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Activity heatmap */}
      <ChartCard title={t('heatmap.title')} subtitle={t('heatmap.subtitle')} loading={heatmap.isLoading} empty={(heatmap.data?.total ?? 0) === 0} emptyLabel={t('reports.empty')} height={0}>
        {heatmap.data && <ActivityHeatmap data={heatmap.data} />}
      </ChartCard>

      {/* Top media */}
      <ChartCard title={t('charts.topMedia')} loading={topMedia.isLoading} empty={(topMedia.data?.length ?? 0) === 0} emptyLabel={t('reports.empty')} height={0}>
        <ul className="divide-y divide-white/5">
          {(topMedia.data ?? []).map((m, i) => (
            <li key={m.title + i} className="flex items-center gap-3 py-2 text-sm">
              <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{m.title}</span>
              <Badge variant="secondary">{m.mediaType}</Badge>
              <span className="shrink-0 tabular-nums text-muted-foreground">{m.plays} {t('charts.plays')}</span>
            </li>
          ))}
        </ul>
      </ChartCard>

      {/* Provider health */}
      <ProviderStatusPanel connections={dash.data.connections} onSync={() => void runSync()} syncing={syncing} />
    </div>
  );
}
