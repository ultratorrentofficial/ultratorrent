import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Download,
  Gauge,
  HardDriveDownload,
  Pause,
  Sprout,
  TriangleAlert,
} from 'lucide-react';
import { api, type ActivityItem } from '@/lib/api';
import { useRealtime } from '@/realtime/RealtimeContext';
import { formatBytes, formatRatio, formatRelativeTime, formatSpeed } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

export function DashboardPage() {
  const { t } = useTranslation('dashboard');
  const { stats, bandwidth, engineOnline } = useRealtime();

  const summaryQuery = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: api.dashboard.summary,
    refetchInterval: 15000,
  });

  const activityQuery = useQuery({
    queryKey: ['dashboard', 'activity'],
    queryFn: api.dashboard.activity,
    refetchInterval: 20000,
  });

  const summary = summaryQuery.data;

  // Prefer live socket rates; fall back to the polled summary.
  const downloadRate = stats?.downloadRate ?? summary?.downloadRate ?? 0;
  const uploadRate = stats?.uploadRate ?? summary?.uploadRate ?? 0;
  const online = engineOnline ?? summary?.engineOnline ?? false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('page.subtitle')}</p>
        </div>
        <EngineStatusBadge online={online} />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label={t('stats.download')}
          value={formatSpeed(downloadRate)}
          icon={<ArrowDownToLine className="h-5 w-5" />}
          tone="info"
          loading={summaryQuery.isLoading && !stats}
        />
        <StatCard
          label={t('stats.upload')}
          value={formatSpeed(uploadRate)}
          icon={<ArrowUpFromLine className="h-5 w-5" />}
          tone="success"
          loading={summaryQuery.isLoading && !stats}
        />
        <StatCard
          label={t('stats.shareRatio')}
          value={formatRatio(summary?.ratio)}
          icon={<Gauge className="h-5 w-5" />}
          tone="primary"
          loading={summaryQuery.isLoading}
          sub={t('stats.uploadedSub', { size: formatBytes(summary?.totalUploaded) })}
        />
        <StatCard
          label={t('stats.torrents')}
          value={String(summary?.totalTorrents ?? 0)}
          icon={<HardDriveDownload className="h-5 w-5" />}
          tone="accent"
          loading={summaryQuery.isLoading}
          sub={t('stats.activeSub', { count: summary?.downloading ?? 0 })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Bandwidth chart */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>{t('bandwidth.title')}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {t('bandwidth.samples', { count: bandwidth.length })}
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <LegendDot className="bg-info" label={t('bandwidth.legendDown')} />
              <LegendDot className="bg-success" label={t('bandwidth.legendUp')} />
            </div>
          </CardHeader>
          <CardContent>
            <BandwidthChart />
          </CardContent>
        </Card>

        {/* State breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>{t('states.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {summaryQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : (
              <>
                <StateRow icon={<Download className="h-4 w-4 text-info" />} label={t('states.downloading')} value={summary?.downloading ?? 0} />
                <StateRow icon={<Sprout className="h-4 w-4 text-success" />} label={t('states.seeding')} value={summary?.seeding ?? 0} />
                <StateRow icon={<CheckCircle2 className="h-4 w-4 text-success" />} label={t('states.completed')} value={summary?.completed ?? 0} />
                <StateRow icon={<Pause className="h-4 w-4 text-warning" />} label={t('states.paused')} value={summary?.paused ?? 0} />
                <StateRow icon={<TriangleAlert className="h-4 w-4 text-destructive" />} label={t('states.errored')} value={summary?.errored ?? 0} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle>{t('activity.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {activityQuery.isLoading ? (
            <CenteredSpinner />
          ) : activityQuery.data && activityQuery.data.length > 0 ? (
            <ul className="divide-y divide-border/60">
              {activityQuery.data.slice(0, 12).map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Activity className="h-6 w-6" />}
              title={t('activity.emptyTitle')}
              description={t('activity.emptyDescription')}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BandwidthChart() {
  const { t } = useTranslation('dashboard');
  const { bandwidth } = useRealtime();

  const data = useMemo(
    () => bandwidth.map((s) => ({ label: s.label, down: s.down, up: s.up })),
    [bandwidth],
  );

  if (data.length === 0) {
    return (
      <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">
        {t('bandwidth.waiting')}
      </div>
    );
  }

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="downGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(210 90% 60%)" stopOpacity={0.45} />
              <stop offset="100%" stopColor="hsl(210 90% 60%)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="upGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(152 60% 48%)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="hsl(152 60% 48%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 14% 18%)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: 'hsl(240 8% 60%)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'hsl(240 8% 60%)' }}
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(v: number) => formatBytes(v, 0)}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(240 22% 7%)',
              border: '1px solid hsl(240 14% 18%)',
              borderRadius: 12,
              fontSize: 12,
            }}
            labelStyle={{ color: 'hsl(240 8% 70%)' }}
            formatter={(value: number, name: string) => [
              formatSpeed(value),
              name === 'down' ? t('bandwidth.tooltipDown') : t('bandwidth.tooltipUp'),
            ]}
          />
          <Area
            type="monotone"
            dataKey="down"
            stroke="hsl(210 90% 60%)"
            strokeWidth={2}
            fill="url(#downGrad)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="up"
            stroke="hsl(152 60% 48%)"
            strokeWidth={2}
            fill="url(#upGrad)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone: 'info' | 'success' | 'primary' | 'accent';
  sub?: string;
  loading?: boolean;
}

function StatCard({ label, value, icon, tone, sub, loading }: StatCardProps) {
  const tones: Record<StatCardProps['tone'], string> = {
    info: 'text-info bg-info/10',
    success: 'text-success bg-success/10',
    primary: 'text-primary bg-primary/10',
    accent: 'text-accent bg-accent/10',
  };
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </p>
            {loading ? (
              <Skeleton className="mt-2 h-7 w-24" />
            ) : (
              <p className="mt-1 truncate text-2xl font-bold tracking-tight tabular-nums">{value}</p>
            )}
            {sub && !loading && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
          </div>
          <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', tones[tone])}>
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StateRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-md px-2 py-2 transition-colors hover:bg-white/[0.03]">
      <div className="flex items-center gap-2.5 text-sm">
        {icon}
        <span className="text-foreground/90">{label}</span>
      </div>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span className={cn('h-2 w-2 rounded-full', className)} />
      {label}
    </span>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const tone: Record<NonNullable<ActivityItem['level']>, string> = {
    info: 'text-info',
    success: 'text-success',
    warning: 'text-warning',
    error: 'text-destructive',
  };
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        className={cn(
          'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current',
          tone[item.level ?? 'info'],
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground/90">{item.message}</span>
        {item.detail && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {item.detail}
          </span>
        )}
      </span>
      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatRelativeTime(item.at)}
      </span>
    </li>
  );
}

function EngineStatusBadge({ online }: { online: boolean }) {
  const { t } = useTranslation('dashboard');
  return (
    <Badge variant={online ? 'success' : 'destructive'} dot className="px-3 py-1">
      {online ? t('engine.online') : t('engine.offline')}
    </Badge>
  );
}
