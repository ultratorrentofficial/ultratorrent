import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

/** Read-only view of the engine's active tuning values (honest — reflects the runtime). */
export function JobsSettingsPage() {
  const { t } = useTranslation('jobs');
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['jobs', 'settings'], queryFn: () => api.jobs.settings() });

  if (isLoading) return <CenteredSpinner label={t('settingsPage.title')} />;
  if (isError || !data) return <ErrorState message={t('settingsPage.title')} onRetry={() => refetch()} />;

  const rows: { key: 'progressThrottleMs' | 'stallThresholdMs' | 'stallScanIntervalMs' | 'defaultMaxAttempts'; unit?: string }[] = [
    { key: 'progressThrottleMs', unit: 'ms' },
    { key: 'stallThresholdMs', unit: 'ms' },
    { key: 'stallScanIntervalMs', unit: 'ms' },
    { key: 'defaultMaxAttempts' },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('settingsPage.note')}</p>
      <Card>
        <CardContent className="divide-y divide-border/40 p-0">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-sm">{t(`settingsPage.${r.key}`)}</span>
              <span className="text-sm font-medium tabular-nums">
                {data[r.key]}
                {r.unit ? ` ${r.unit}` : ''}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
