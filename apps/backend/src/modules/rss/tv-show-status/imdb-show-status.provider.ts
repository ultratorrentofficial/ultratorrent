import type { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { isTvType } from '../../media/imdb/imdb-match';
import type {
  EpisodeRef,
  ProviderCapabilities,
  ShowDetails,
  ShowSearchHit,
  TvShowStatusProvider,
} from './tv-show-status-provider';

/**
 * IMDb-dataset airing-status provider. IMDb has no textual airing status, so the
 * "ended" signal is `IMDbTitle.endYear` (set ⇒ concluded) combined with a series
 * `titleType`. No episode-schedule data, so no next-episode capability. Lower
 * confidence than TMDB. Requires the user-imported IMDb dataset.
 */
export class ImdbTvShowStatusProvider implements TvShowStatusProvider {
  readonly name = 'imdb';

  constructor(private readonly prisma: PrismaService) {}

  getProviderCapabilities(): ProviderCapabilities {
    return {
      name: this.name,
      canSearch: true,
      canStatus: true,
      canNextEpisode: false,
      canLastEpisode: false,
      confidence: 0.6,
    };
  }

  async searchShow(query: string, year?: number | null): Promise<ShowSearchHit[]> {
    const rows = await this.prisma.iMDbTitle.findMany({
      where: {
        primaryTitle: { equals: query, mode: 'insensitive' },
        titleType: { in: ['tvSeries', 'tvMiniSeries'] },
        ...(year ? { startYear: year } : {}),
      },
      take: 5,
      orderBy: { startYear: 'desc' },
    });
    return rows.map((r) => ({
      providerShowId: r.tconst,
      title: r.primaryTitle,
      year: r.startYear ?? null,
    }));
  }

  async getShowStatus(): Promise<string | null> {
    // IMDb has no textual status; the normalizer derives it from endYear.
    return null;
  }

  async getShowDetails(externalId: string): Promise<ShowDetails | null> {
    const t = await this.prisma.iMDbTitle.findUnique({ where: { tconst: externalId } });
    if (!t || !isTvType(t.titleType)) return null;
    return {
      providerShowId: t.tconst,
      title: t.primaryTitle,
      originalStatus: null,
      firstAirDate: t.startYear ? `${t.startYear}-01-01` : null,
      lastAirDate: t.endYear ? `${t.endYear}-12-31` : null,
      nextEpisode: null,
      lastEpisode: null,
      totalSeasons: null,
      totalEpisodes: null,
      overview: null,
      posterUrl: null,
      endYear: t.endYear ?? null,
      // A tvSeries with no end year is presumed still running.
      assumeContinuing: t.titleType === 'tvSeries' && t.endYear == null,
    };
  }

  async getNextEpisode(): Promise<EpisodeRef | null> {
    return null;
  }

  async getLastEpisode(): Promise<EpisodeRef | null> {
    return null;
  }
}
