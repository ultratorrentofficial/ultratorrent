import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { decodeSeriesKey } from '../series-grouping';
import {
  type HealthStatus, isUnorganisedPath, rollup, scoreItem,
} from './media-health-score';

export interface EpisodeHealth {
  itemId: string;
  season: number | null;
  episode: number | null;
  score: number;
  status: HealthStatus;
  reasons: string[];
}

export interface SeasonHealth {
  seasonNumber: number;
  episodes: number;
  score: number;
  status: HealthStatus;
  /** How many episodes carry each reason — what to fix first, and how much of it. */
  reasonCounts: Record<string, number>;
}

export interface ShowHealth {
  score: number;
  status: HealthStatus;
  seasons: SeasonHealth[];
  episodes: EpisodeHealth[];
  totals: { episodes: number; seasons: number; bytes: string };
}

/**
 * Health for a show, its seasons and its episodes, in one pass.
 *
 * Distinct from `MediaHealthService`, which answers a LIBRARY-wide dashboard
 * question ("how many items lack artwork"). This one scores a single show and
 * everything under it; sharing a name would have made the two indistinguishable
 * at the injection site.
 *
 * Scores come from the pure domain beside this; the service's whole job is
 * assembling facts cheaply. That split matters because the score is what an
 * operator acts on — it has to be explainable and identical everywhere, and a
 * number computed inline in three query sites would drift.
 *
 * One query, counts not lists. Rendering "3 subtitles" or "has artwork" from
 * loaded relation rows would pull tens of thousands of records for a long
 * series to answer questions that are booleans.
 */
@Injectable()
export class ShowHealthService {
  constructor(private readonly prisma: PrismaService) {}

  async forShow(seriesKey: string, libraryId?: string): Promise<ShowHealth> {
    const { kind, value } = decodeSeriesKey(seriesKey);
    const where = kind === 'dir'
      ? { path: { startsWith: `${value}/` }, ...(libraryId ? { libraryId } : {}) }
      : { title: value, ...(libraryId ? { libraryId } : {}) };

    const rows = await this.prisma.mediaItem.findMany({
      where,
      select: {
        id: true, season: true, episode: true, path: true, matchStatus: true,
        duplicateGroupId: true,
        metadata: { select: { id: true } },
        files: { select: { size: true, techSource: true } },
        _count: { select: { artwork: true, subtitles: true } },
      },
      orderBy: [{ season: 'asc' }, { episode: 'asc' }],
    });

    let bytes = 0n;
    const episodes: EpisodeHealth[] = rows.map((r) => {
      for (const f of r.files) bytes += f.size ?? 0n;
      const result = scoreItem({
        matched: r.matchStatus !== 'unmatched',
        hasMetadata: !!r.metadata,
        hasArtwork: r._count.artwork > 0,
        hasSubtitles: r._count.subtitles > 0,
        isDuplicate: r.duplicateGroupId != null,
        // `techSource: 'probe'` means measured; 'filename' means guessed from a
        // name the renamer has usually already stripped.
        hasMeasuredTech: r.files.some((f) => f.techSource === 'probe'),
        unorganised: isUnorganisedPath(r.path),
      });
      return {
        itemId: r.id, season: r.season, episode: r.episode,
        score: result.score, status: result.status, reasons: result.reasons,
      };
    });

    const bySeason = new Map<number, EpisodeHealth[]>();
    for (const ep of episodes) {
      const s = ep.season ?? 0;
      (bySeason.get(s) ?? bySeason.set(s, []).get(s)!).push(ep);
    }

    const seasons: SeasonHealth[] = [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seasonNumber, eps]) => {
        const counts: Record<string, number> = {};
        for (const ep of eps) for (const r of ep.reasons) counts[r] = (counts[r] ?? 0) + 1;
        const { score, status } = rollup(eps.map((e) => e.score));
        return { seasonNumber, episodes: eps.length, score, status, reasonCounts: counts };
      });

    /*
     * The show rolls up from EPISODES, not from season scores.
     *
     * Averaging season averages weights a two-episode special the same as a
     * twenty-episode season, so a show's headline number would move when a
     * single special was added.
     */
    const overall = rollup(episodes.map((e) => e.score));

    return {
      ...overall,
      seasons,
      episodes,
      // bigint does not survive JSON, and a byte count large enough to matter
      // is large enough to lose precision as a double.
      totals: { episodes: episodes.length, seasons: seasons.length, bytes: bytes.toString() },
    };
  }
}
