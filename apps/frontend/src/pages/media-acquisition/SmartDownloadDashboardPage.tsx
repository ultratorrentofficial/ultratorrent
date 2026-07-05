import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type AcquisitionEvaluation } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

const DECISION_VARIANT: Record<string, BadgeProps['variant']> = {
  download: 'success',
  upgrade_existing: 'success',
  replace_existing: 'success',
  wait: 'info',
  hold_for_approval: 'warning',
  manual_review: 'warning',
  skip: 'secondary',
};

function Widget({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className={cn('text-2xl font-semibold tabular-nums', tone)}>{formatNumber(value)}</div>
        <div className="mt-1 text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

function EvaluationList({ items, empty }: { items: AcquisitionEvaluation[] | undefined; empty: string }) {
  const { t } = useTranslation('media');
  if (!items || items.length === 0) return <EmptyState title={empty} />;
  return (
    <ul className="divide-y divide-white/5 rounded-md border border-white/5">
      {items.map((e) => (
        <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <Badge variant={DECISION_VARIANT[e.decision] ?? 'secondary'}>
            {t(`acquisition.simulator.decision.${e.decision}`, { defaultValue: e.decision })}
          </Badge>
          <span className="min-w-0 flex-1 truncate">{e.releaseName}</span>
          <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block">{e.decisionReason}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTime(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export function SmartDownloadDashboardPage() {
  const { t } = useTranslation('media');
  const [tab, setTab] = useState('waiting');

  const overview = useQuery({ queryKey: ['mediaAcquisition', 'overview'], queryFn: () => api.mediaAcquisition.overview() });
  const waiting = useQuery({ queryKey: ['mediaAcquisition', 'waiting'], queryFn: () => api.mediaAcquisition.waiting(), enabled: tab === 'waiting' });
  const upgrades = useQuery({ queryKey: ['mediaAcquisition', 'upgrades'], queryFn: () => api.mediaAcquisition.upgrades(), enabled: tab === 'upgrades' });
  const rejected = useQuery({ queryKey: ['mediaAcquisition', 'rejected'], queryFn: () => api.mediaAcquisition.rejected(), enabled: tab === 'rejected' });

  if (overview.isLoading) return <CenteredSpinner />;
  if (overview.isError || !overview.data) return <ErrorState title={t('acquisition.dashboard.loadError')} onRetry={() => void overview.refetch()} />;

  const o = overview.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('acquisition.dashboard.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('acquisition.dashboard.subtitle')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Widget label={t('acquisition.dashboard.widget.approved')} value={o.approvals.approved} tone="text-success" />
        <Widget label={t('acquisition.dashboard.widget.pendingApproval')} value={o.approvals.pending} tone="text-warning" />
        <Widget label={t('acquisition.dashboard.widget.waiting')} value={o.decisions.waiting} tone="text-info" />
        <Widget label={t('acquisition.dashboard.widget.upgrades')} value={o.decisions.upgrades} tone="text-success" />
        <Widget label={t('acquisition.dashboard.widget.rejected')} value={o.approvals.rejected} tone="text-destructive" />
        <Widget label={t('acquisition.dashboard.widget.missingEpisodes')} value={o.missing.episodes} />
        <Widget label={t('acquisition.dashboard.widget.missingMovies')} value={o.missing.movies} />
        <Widget label={t('acquisition.dashboard.widget.watchlist')} value={o.watchlist.active} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t('acquisition.dashboard.recent')}</h2>
        <EvaluationList items={o.recent as unknown as AcquisitionEvaluation[]} empty={t('acquisition.dashboard.noRecent')} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="waiting">{t('acquisition.dashboard.tab.waiting')}</TabsTrigger>
          <TabsTrigger value="upgrades">{t('acquisition.dashboard.tab.upgrades')}</TabsTrigger>
          <TabsTrigger value="rejected">{t('acquisition.dashboard.tab.rejected')}</TabsTrigger>
        </TabsList>
        <TabsContent value="waiting">
          {waiting.isLoading ? <CenteredSpinner /> : <EvaluationList items={waiting.data} empty={t('acquisition.dashboard.emptyWaiting')} />}
        </TabsContent>
        <TabsContent value="upgrades">
          {upgrades.isLoading ? <CenteredSpinner /> : <EvaluationList items={upgrades.data} empty={t('acquisition.dashboard.emptyUpgrades')} />}
        </TabsContent>
        <TabsContent value="rejected">
          {rejected.isLoading ? <CenteredSpinner /> : <EvaluationList items={rejected.data} empty={t('acquisition.dashboard.emptyRejected')} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
