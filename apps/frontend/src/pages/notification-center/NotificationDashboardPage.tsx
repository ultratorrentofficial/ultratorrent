import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Bell, CheckCircle2, Clock, Send, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="text-amber-400">{icon}</div>
        <div>
          <div className="text-2xl font-semibold">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  sent: 'default', delivered: 'default', failed: 'destructive', queued: 'secondary', retrying: 'secondary', throttled: 'outline', skipped: 'outline', cancelled: 'outline',
};

export function NotificationDashboardPage() {
  const { t } = useTranslation('notificationCenter');
  const q = useQuery({ queryKey: ['nc', 'dashboard'], queryFn: () => api.notificationCenter.dashboard(), refetchInterval: 15000 });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError || !q.data) return <ErrorState title={t('dashboard.loadError')} onRetry={() => void q.refetch()} />;
  const d = q.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.subtitle')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat icon={<Send className="h-5 w-5" />} label={t('dashboard.channels')} value={d.channels} />
        <Stat icon={<Users className="h-5 w-5" />} label={t('dashboard.recipients')} value={d.recipients} />
        <Stat icon={<Bell className="h-5 w-5" />} label={t('dashboard.enabledRules')} value={d.enabledRules} />
        <Stat icon={<Clock className="h-5 w-5" />} label={t('dashboard.queueSize')} value={d.queueSize} />
        <Stat icon={<CheckCircle2 className="h-5 w-5" />} label={t('dashboard.successRate')} value={d.successRate == null ? '—' : `${d.successRate}%`} />
      </div>

      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('dashboard.recent')}</h2>
          {d.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('dashboard.noRecent')}</p>
          ) : (
            <div className="space-y-1.5">
              {d.recent.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 border-t border-white/5 py-1.5 text-sm first:border-0">
                  <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>{t(`status.${r.status}`, { defaultValue: r.status })}</Badge>
                  <span className="font-medium">{r.event}</span>
                  <span className="text-xs text-muted-foreground">{r.provider}{r.destination ? ` · ${r.destination}` : ''}</span>
                  <span className="flex-1" />
                  <span className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
