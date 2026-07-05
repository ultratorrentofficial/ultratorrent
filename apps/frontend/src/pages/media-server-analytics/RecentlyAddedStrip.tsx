import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type MediaServerRecentlyAddedItem } from '@/lib/api';
import { MediaPoster } from '@/components/media/MediaPoster';
import { EmptyState } from '@/components/ui/feedback';
import { mediaTypeColor } from './analytics-colors';

/** One-line subtitle: "2019 · S02E05" style, from whatever fields exist. */
function subtitle(item: MediaServerRecentlyAddedItem): string {
  const parts: string[] = [];
  if (item.year) parts.push(String(item.year));
  if (item.season != null && item.episode != null) {
    parts.push(`S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`);
  }
  return parts.join(' · ');
}

/**
 * Artwork-rich horizontal strip of recently-added library items. Posters come
 * from the Media Manager library (provider-native or imported), rendered via
 * MediaPoster which handles remote urls, local blobs, lazy-loading and a graceful
 * icon fallback — so a missing or broken poster never breaks the dashboard.
 */
export function RecentlyAddedStrip() {
  const { t } = useTranslation('mediaServerAnalytics');
  const q = useQuery({
    queryKey: ['msa', 'recently-added'],
    queryFn: () => api.mediaServerAnalytics.recentlyAdded(),
  });

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">{t('recentlyAdded.title')}</h2>
      {q.isLoading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="w-[110px] shrink-0 animate-pulse">
              <div className="aspect-[2/3] rounded-lg bg-white/[0.04]" />
              <div className="mt-2 h-3 w-full rounded bg-white/[0.04]" />
              <div className="mt-1 h-2.5 w-2/3 rounded bg-white/[0.03]" />
            </div>
          ))}
        </div>
      ) : !q.data || q.data.length === 0 ? (
        <EmptyState title={t('recentlyAdded.empty')} />
      ) : (
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
          {q.data.map((item) => (
            <div key={item.id} className="w-[110px] shrink-0">
              <MediaPoster
                artwork={item.poster}
                alt={item.title}
                className="aspect-[2/3] w-full rounded-lg ring-1 ring-white/5"
                iconClassName="h-6 w-6"
              />
              <div className="mt-2 flex items-start gap-1.5">
                <span
                  className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: mediaTypeColor(item.mediaType) }}
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium leading-tight" title={item.title}>
                    {item.title}
                  </div>
                  {subtitle(item) && (
                    <div className="truncate text-[11px] text-muted-foreground">{subtitle(item)}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
