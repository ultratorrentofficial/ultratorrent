import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const HEALTH_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  online: 'default', offline: 'destructive', degraded: 'secondary', unknown: 'outline',
};

export function NotificationProviderHealthPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nc', 'channels'], queryFn: () => api.notificationCenter.channels(), refetchInterval: 30000 });
  const test = useMutation({
    mutationFn: (id: string) => api.notificationCenter.testChannel(id),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['nc', 'channels'] }); r.ok ? toast.success(t('channels.testOk')) : toast.error(t('channels.testFailed'), r.error); },
  });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError) return <ErrorState title={t('providerHealth.loadError')} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('providerHealth.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('providerHealth.subtitle')}</p>
      </div>
      {(q.data ?? []).length === 0 && <EmptyState title={t('providerHealth.empty')} />}
      {(q.data ?? []).map((c) => (
        <Card key={c.id}>
          <CardContent className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <Badge variant={HEALTH_VARIANT[c.healthStatus] ?? 'outline'}>{t(`health.${c.healthStatus}`, { defaultValue: c.healthStatus })}</Badge>
            <span className="font-medium">{c.name}</span>
            <Badge variant="secondary">{c.provider}</Badge>
            <span className="text-xs text-muted-foreground">{t('channels.sentFailed', { sent: c.sentCount, failed: c.failedCount })}</span>
            {c.lastError && <span className="text-xs text-destructive">{c.lastError}</span>}
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground">{c.lastHealthCheckAt ? new Date(c.lastHealthCheckAt).toLocaleString() : t('providerHealth.never')}</span>
            <Button variant="secondary" size="sm" onClick={() => test.mutate(c.id)}><Zap className="h-3.5 w-3.5" />{t('channels.test')}</Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
