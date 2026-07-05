import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

function duration(seconds: number | null): string {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function WatchHistoryPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const q = useQuery({ queryKey: ['mediaServerAnalytics', 'watch-history'], queryFn: () => api.mediaServerAnalytics.watchHistory() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('watchHistory.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('watchHistory.subtitle')}</p>
      </div>

      {q.isLoading ? (
        <CenteredSpinner />
      ) : q.isError ? (
        <ErrorState title={t('watchHistory.loadError')} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.length === 0 ? (
        <EmptyState title={t('watchHistory.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-white/5">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-white/5">
                <th className="px-3 py-2">{t('watchHistory.col.title')}</th>
                <th className="px-3 py-2">{t('watchHistory.col.user')}</th>
                <th className="px-3 py-2">{t('watchHistory.col.library')}</th>
                <th className="px-3 py-2">{t('watchHistory.col.method')}</th>
                <th className="px-3 py-2">{t('watchHistory.col.watched')}</th>
                <th className="px-3 py-2">{t('watchHistory.col.when')}</th>
                <th className="px-3 py-2">{t('watchHistory.col.source')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((h) => (
                <tr key={h.id} className="border-b border-white/5 last:border-0">
                  <td className="max-w-[20rem] truncate px-3 py-2">{h.title}</td>
                  <td className="px-3 py-2 text-muted-foreground">{h.userName ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{h.libraryName ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{h.playbackMethod ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{duration(h.watchedSeconds)}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{formatDateTime(h.startedAt)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{h.importSource ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
