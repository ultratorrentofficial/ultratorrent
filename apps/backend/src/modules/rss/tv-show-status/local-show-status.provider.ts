import type { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type {
  EpisodeRef,
  ProviderCapabilities,
  ShowDetails,
  ShowSearchHit,
  TvShowStatusProvider,
} from './tv-show-status-provider';

/**
 * Local fallback provider — resolves a show only from the library's own scanned
 * metadata (Media Manager items). It has no authoritative airing status, so it
 * can confirm a show exists locally but reports `unknown` status at low
 * confidence; used only when no online provider is available.
 */
export class LocalNfoTvShowStatusProvider implements TvShowStatusProvider {
  readonly name = 'local';

  constructor(private readonly prisma: PrismaService) {}

  getProviderCapabilities(): ProviderCapabilities {
    return {
      name: this.name,
      canSearch: true,
      canStatus: false,
      canNextEpisode: false,
      canLastEpisode: false,
      confidence: 0.3,
    };
  }

  async searchShow(query: string): Promise<ShowSearchHit[]> {
    const rows = await this.prisma.mediaItem.findMany({
      where: {
        mediaType: { in: ['tv', 'anime'] },
        title: { equals: query, mode: 'insensitive' },
      },
      distinct: ['title'],
      select: { title: true, year: true },
      take: 5,
    });
    return rows.map((r) => ({
      providerShowId: r.title, // local anchor is the show title
      title: r.title,
      year: r.year ?? null,
    }));
  }

  async getShowStatus(): Promise<string | null> {
    return null; // no local airing status
  }

  async getShowDetails(externalId: string): Promise<ShowDetails | null> {
    const item = await this.prisma.mediaItem.findFirst({
      where: { mediaType: { in: ['tv', 'anime'] }, title: { equals: externalId, mode: 'insensitive' } },
      select: { title: true, year: true },
    });
    if (!item) return null;
    return {
      providerShowId: item.title,
      title: item.title,
      originalStatus: null,
      firstAirDate: item.year ? `${item.year}-01-01` : null,
      lastAirDate: null,
      nextEpisode: null,
      lastEpisode: null,
      totalSeasons: null,
      totalEpisodes: null,
      overview: null,
      posterUrl: null,
    };
  }

  async getNextEpisode(): Promise<EpisodeRef | null> {
    return null;
  }

  async getLastEpisode(): Promise<EpisodeRef | null> {
    return null;
  }
}
