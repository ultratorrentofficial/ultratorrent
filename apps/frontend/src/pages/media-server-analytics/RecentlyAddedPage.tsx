import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

function seasonEpisode(season: number | null, episode: number | null): string | null {
  if (season == null) return null;
  return `S${String(season).padStart(2, '0')}${episode != null ? `E${String(episode).padStart(2, '0')}` : ''}`;
}

export function RecentlyAddedPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const q = useQuery({ queryKey: ['mediaServerAnalytics', 'recently-added'], queryFn: () => api.mediaServerAnalytics.recentlyAdded() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('recentlyAdded.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('recentlyAdded.subtitle')}</p>
      </div>

      {q.isLoading ? (
        <CenteredSpinner />
      ) : q.isError ? (
        <ErrorState title={t('recentlyAdded.loadError')} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.length === 0 ? (
        <EmptyState title={t('recentlyAdded.empty')} />
      ) : (
        <ul className="divide-y divide-white/5 rounded-md border border-white/5">
          {q.data.map((i) => {
            const se = seasonEpisode(i.season, i.episode);
            return (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {i.title}
                  {i.year != null && <span className="ml-1 text-muted-foreground">({i.year})</span>}
                  {se && <span className="ml-2 text-xs text-muted-foreground">{se}</span>}
                </span>
                <Badge variant="secondary">{i.mediaType}</Badge>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDateTime(i.addedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
