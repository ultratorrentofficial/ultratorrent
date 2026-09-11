import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { DiscoveredMediaItem } from '@/lib/api';

/**
 * "Look it up yourself" links on a discovery card.
 *
 * A reviewer deciding whether to monitor a title wants the full record — cast,
 * reviews, episode list — which lives on IMDb/TMDB/TVmaze, not on the card. Each
 * link is built purely from the id the discovery record already carries
 * (`externalIds`), so this only renders a provider when its id is present: a
 * TMDB-sourced movie shows just TMDB, a TV series may show several. Nothing is
 * fetched — these are outbound links the user opens in a new tab.
 */

/** The `tmdb` id is a bare number; the path differs for a film vs a series. */
function tmdbUrl(id: string, mediaType: string): string {
  return `https://www.themoviedb.org/${mediaType === 'movie' ? 'movie' : 'tv'}/${encodeURIComponent(id)}`;
}

/** `externalIds.imdb` is already a `tt…` tconst; IMDb uses it for film and TV alike. */
function imdbUrl(imdbId: string): string {
  return `https://www.imdb.com/title/${encodeURIComponent(imdbId)}/`;
}

/** TVmaze is TV-only; the `tvmaze` id is the numeric show id. */
function tvmazeUrl(id: string): string {
  return `https://www.tvmaze.com/shows/${encodeURIComponent(id)}`;
}

export function ExternalLinks({ item }: { item: DiscoveredMediaItem }) {
  const { t } = useTranslation('mediaDiscovery');
  const ids = item.externalIds ?? {};

  const links: Array<{ provider: string; href: string }> = [];
  if (ids.imdb) links.push({ provider: 'IMDb', href: imdbUrl(ids.imdb) });
  if (ids.tmdb) links.push({ provider: 'TMDB', href: tmdbUrl(ids.tmdb, item.mediaType) });
  if (ids.tvmaze && item.mediaType === 'tv') links.push({ provider: 'TVmaze', href: tvmazeUrl(ids.tvmaze) });

  if (links.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {links.map((l) => (
        <a
          key={l.provider}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          title={t('card.viewOn', { provider: l.provider })}
          aria-label={t('card.viewOn', { provider: l.provider })}
          className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
        >
          {l.provider}
          <ExternalLink className="h-2.5 w-2.5" aria-hidden />
        </a>
      ))}
    </div>
  );
}
