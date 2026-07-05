import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatNumber, formatDateTime } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

function watchTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Widget({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

function Bars({ items, max }: { items: { label: string; plays: number }[]; max: number }) {
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-3 text-sm">
          <span className="w-32 shrink-0 truncate text-muted-foreground">{it.label}</span>
          <Progress value={max > 0 ? it.plays / max : 0} className="flex-1" />
          <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{it.plays}</span>
        </div>
      ))}
    </div>
  );
}

export function ReportsPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const [tab, setTab] = useState('usage');

  const usage = useQuery({ queryKey: ['msa', 'report', 'usage'], queryFn: () => api.mediaServerAnalytics.reportUsage(), enabled: tab === 'usage' });
  const users = useQuery({ queryKey: ['msa', 'report', 'users'], queryFn: () => api.mediaServerAnalytics.reportUsers(), enabled: tab === 'users' });
  const libraries = useQuery({ queryKey: ['msa', 'report', 'libraries'], queryFn: () => api.mediaServerAnalytics.reportLibraries(), enabled: tab === 'libraries' });
  const playback = useQuery({ queryKey: ['msa', 'report', 'playback'], queryFn: () => api.mediaServerAnalytics.reportPlayback(), enabled: tab === 'playback' });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('reports.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('reports.subtitle')}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="usage">{t('reports.tab.usage')}</TabsTrigger>
          <TabsTrigger value="users">{t('reports.tab.users')}</TabsTrigger>
          <TabsTrigger value="libraries">{t('reports.tab.libraries')}</TabsTrigger>
          <TabsTrigger value="playback">{t('reports.tab.playback')}</TabsTrigger>
        </TabsList>

        <TabsContent value="usage">
          {usage.isLoading ? <CenteredSpinner /> : usage.isError || !usage.data ? (
            <ErrorState title={t('reports.loadError')} onRetry={() => void usage.refetch()} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Widget label={t('reports.usage.plays')} value={formatNumber(usage.data.totalPlays)} />
              <Widget label={t('reports.usage.watchTime')} value={watchTime(usage.data.totalWatchSeconds)} />
              <Widget label={t('reports.usage.users')} value={formatNumber(usage.data.uniqueUsers)} />
            </div>
          )}
        </TabsContent>

        <TabsContent value="users">
          {users.isLoading ? <CenteredSpinner /> : users.isError ? (
            <ErrorState title={t('reports.loadError')} onRetry={() => void users.refetch()} />
          ) : !users.data || users.data.length === 0 ? <EmptyState title={t('reports.empty')} /> : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-white/5">
                  <th className="px-3 py-2">{t('reports.col.user')}</th>
                  <th className="px-3 py-2">{t('reports.col.plays')}</th>
                  <th className="px-3 py-2">{t('reports.col.watchTime')}</th>
                  <th className="px-3 py-2">{t('reports.col.lastSeen')}</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.userName} className="border-b border-white/5 last:border-0">
                    <td className="px-3 py-2">{u.userName}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{u.plays}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{watchTime(u.watchSeconds)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{u.lastSeen ? formatDateTime(u.lastSeen) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TabsContent>

        <TabsContent value="libraries">
          {libraries.isLoading ? <CenteredSpinner /> : libraries.isError ? (
            <ErrorState title={t('reports.loadError')} onRetry={() => void libraries.refetch()} />
          ) : !libraries.data || libraries.data.length === 0 ? <EmptyState title={t('reports.empty')} /> : (
            <Bars max={Math.max(...libraries.data.map((l) => l.plays))} items={libraries.data.map((l) => ({ label: l.libraryName, plays: l.plays }))} />
          )}
        </TabsContent>

        <TabsContent value="playback">
          {playback.isLoading ? <CenteredSpinner /> : playback.isError || !playback.data ? (
            <ErrorState title={t('reports.loadError')} onRetry={() => void playback.refetch()} />
          ) : playback.data.byMethod.length === 0 ? <EmptyState title={t('reports.empty')} /> : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t('reports.col.method')}</h3>
                <Bars max={Math.max(...playback.data.byMethod.map((m) => m.plays))} items={playback.data.byMethod.map((m) => ({ label: m.method, plays: m.plays }))} />
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t('reports.col.type')}</h3>
                <Bars max={Math.max(...playback.data.byType.map((x) => x.plays))} items={playback.data.byType.map((x) => ({ label: x.type, plays: x.plays }))} />
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
