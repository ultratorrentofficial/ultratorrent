import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Download, History } from 'lucide-react';
import { api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const ACTION_VARIANT: Record<string, 'success' | 'info' | 'warning' | 'destructive' | 'secondary'> = {
  downloaded: 'success',
  synchronized: 'info',
  searched: 'secondary',
  validated: 'warning',
  missing: 'warning',
  failed: 'destructive',
  rejected: 'destructive',
};

export function SubtitleHistoryPage() {
  const { t } = useTranslation('subtitleIntelligence');

  const downloads = useQuery({ queryKey: ['subtitles', 'downloads'], queryFn: () => api.subtitles.downloads() });
  const history = useQuery({ queryKey: ['subtitles', 'history'], queryFn: () => api.subtitles.history() });

  if (downloads.isLoading || history.isLoading) return <CenteredSpinner label={t('common.loading')} />;
  if (downloads.isError || history.isError) return <ErrorState title={t('common.error')} onRetry={() => { void downloads.refetch(); void history.refetch(); }} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <History className="h-6 w-6 text-primary" /> {t('history.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('history.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Download className="h-4 w-4" /> {t('history.installed')}
          </h2>
          {(downloads.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">{t('history.noDownloads')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {downloads.data!.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="font-medium uppercase">{d.language}</span>
                    <span className="text-muted-foreground">{d.provider}</span>
                    <Badge variant={d.status === 'installed' ? 'success' : 'secondary'}>{d.status}</Badge>
                    <span className="text-xs text-muted-foreground">{d.score}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{formatRelativeTime(d.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <History className="h-4 w-4" /> {t('history.activity')}
          </h2>
          {(history.data?.length ?? 0) === 0 ? (
            <EmptyState icon={<History className="h-6 w-6" />} title={t('history.empty')} />
          ) : (
            <ul className="divide-y divide-border">
              {history.data!.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge variant={ACTION_VARIANT[h.action] ?? 'secondary'}>{h.action}</Badge>
                    {h.language && <span className="uppercase">{h.language}</span>}
                    {h.provider && <span className="text-muted-foreground">{h.provider}</span>}
                    <span className="truncate text-xs text-muted-foreground">{h.message}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(h.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
