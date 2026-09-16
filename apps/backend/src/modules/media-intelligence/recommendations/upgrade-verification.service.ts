import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_UPGRADE_CANDIDATES,
  type MediaCandidateDimension,
  type MediaIntelligenceEntityType,
  type MediaUpgradeCandidate,
  type MediaVerificationResult,
  type MediaVerificationStatus,
  type NormalizedPreferenceLadder,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { IndexerService } from '../../indexers/indexer.service';
import { evaluatePreferenceList, showTitleMatch } from '../../rss/match-engine';
import type { MatchCandidateInput } from '../../rss/match-engine';
import { parseTorrentName } from '../../rss/torrent-name-parser';
import { AcquisitionMatchPreferenceService } from '../../media-acquisition/acquisition-match-preference.service';
import { MediaStateAssembler } from '../media-state.assembler';
import { ladderAppliesTo } from '../quality/preference-ladder';
import { confidenceRank } from './confidence-rank';

/**
 * Asking whether a better release can ACTUALLY be obtained.
 *
 * This is the one operation in Media Intelligence that reaches outside the
 * installation, and it runs only when a person explicitly asks. Nothing here
 * is called from a list, a detail page or a sweep — the whole phase rests on
 * the distinction between upgrade POTENTIAL (a higher rung exists in the
 * operator's own ladder) and upgrade AVAILABILITY (such a release can be had
 * today), and only this file may establish the second.
 *
 * **Everything it uses already existed.** No indexer client, no release
 * parser, no matcher and no scorer is introduced:
 *
 *   - `IndexerService.searchAllDetailed` is the only search client in the
 *     codebase, and it reports how many indexers answered and how many threw.
 *   - `AcquisitionMatchPreferenceService` decides which ladder applies; this
 *     file never re-derives that cascade.
 *   - `evaluatePreferenceList` is the authoritative matcher: it parses the
 *     release name and returns which rung it satisfies.
 *   - `representativeQuality` + `evaluateQualityCompliance`, through the
 *     assembler, decide which rung the OWNED copy satisfies.
 *
 * **Superiority is decided by the operator's own ladder, not by intuition.**
 * A candidate is better only when it satisfies a STRICTLY more preferred rung
 * than the owned copy. That is what makes `x264 → x265` at otherwise equal
 * quality a non-upgrade here: it lands on the same rung, so it is not
 * proposed — the same rule Smart Download enforces by subtracting codec from
 * its comparison, expressed in the vocabulary this layer already speaks.
 *
 * **It downloads nothing.** A verified candidate is a normalized snapshot; the
 * grab remains Media Acquisition's, behind that module's own permission.
 */
@Injectable()
export class UpgradeVerificationService {
  private readonly logger = new Logger(UpgradeVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexers: IndexerService,
    private readonly preferences: AcquisitionMatchPreferenceService,
    private readonly assembler: MediaStateAssembler,
  ) {}

  /**
   * Verify one recommendation.
   *
   * Returns the outcome AND persists it, so a reload shows what was found
   * rather than silently re-searching. Failure is reported as `failed`, never
   * as `no_match`: "nobody could look" and "we looked and there is nothing
   * better" are different answers, and collapsing them would let a broken
   * indexer read as a clean library.
   */
  async verify(recommendationId: string, now = new Date()): Promise<MediaVerificationResult> {
    const rec = await this.prisma.mediaIntelligenceRecommendation.findUnique({
      where: { id: recommendationId },
      select: { id: true, type: true, entityType: true, entityId: true },
    });
    if (!rec || rec.type !== 'SEARCH_FOR_QUALITY_UPGRADE') {
      // Nothing else in the catalogue is verifiable; say so rather than
      // running a search that could not mean anything.
      return this.empty('not_required', now);
    }

    await this.prisma.mediaIntelligenceRecommendation.update({
      where: { id: rec.id },
      data: { verification: 'checking' satisfies MediaVerificationStatus },
    });

    try {
      const result = await this.search(
        rec.entityType as MediaIntelligenceEntityType,
        rec.entityId,
        now,
      );
      await this.persist(rec.id, result, now);
      return result;
    } catch (err) {
      /*
       * A crash must not strand the row in `checking` forever. The prompt's
       * own rule, and a real failure mode: a process that dies mid-search
       * leaves a spinner nobody can clear.
       */
      this.logger.warn(`Upgrade verification failed for ${rec.id}: ${(err as Error).message}`);
      const failed = this.empty('failed', now);
      await this.persist(rec.id, failed, now);
      return failed;
    }
  }

  /** The search itself. Pure orchestration over existing services. */
  private async search(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    now: Date,
  ): Promise<MediaVerificationResult> {
    const assembled = await this.assembler.assemble(entityType, entityId);
    if (!assembled) return this.empty('failed', now);

    const facts = assembled.facts as unknown as {
      identity?: { title: string | null; year: number | null };
      quality?: {
        ladder: NormalizedPreferenceLadder;
        compliance: { matchedRung: number | null };
      };
    };
    const title = facts.identity?.title;
    const ladder = facts.quality?.ladder;
    // No title to search for, or no ladder to judge against: there is nothing
    // this could honestly conclude.
    if (!title || !ladder?.rungs.length) return this.empty('no_match', now);

    /*
     * The owned rung is the bar a candidate has to beat. When the owned copy
     * satisfies NO rung, any matching release is an improvement — that is the
     * `below_preference` case, and `rungs.length` stands in for "worse than
     * everything configured".
     */
    const ownedRung = facts.quality?.compliance?.matchedRung ?? ladder.rungs.length;

    const run = await this.indexers.searchAllDetailed({ q: searchTermFor(title) });
    // Every indexer threw. That is an outage, not an empty library.
    if (run.queried > 0 && run.failed === run.queried) {
      return { ...this.empty('failed', now), indexersQueried: run.queried, indexersFailed: run.failed };
    }

    const prefs = await this.preferenceCandidates(entityType);
    // No rung governs this kind of media, so no release can be shown to beat
    // it. Saying "nothing better exists" would be a fabricated verdict.
    if (!prefs.length) return { ...this.empty('no_match', now), indexersQueried: run.queried, indexersFailed: run.failed };
    const rungById = new Map(ladder.rungs.map((r) => [r.id, r]));

    /*
     * ANCHOR ON THE SHOW TITLE FIRST.
     *
     * This is not defensive decoration — without it this method is unsound on
     * this installation. Every rung of the live global ladder is
     * PATTERN-LESS, so `evaluatePreferenceList` judges resolution, codec and
     * size and nothing else: a search for one show would accept any 1080p
     * release an indexer happened to return, including a different show
     * entirely, and persist it as that title's verified upgrade.
     *
     * `AcquisitionMatchPreferenceService.select()` solves this the same way
     * and for the same reason — its own comment records that a looser test
     * mis-grabbed 132 of 714 episodes. Matched against the RAW release name,
     * because `showTitleMatch` does its own show-region extraction and is
     * stricter than the parser's title guess.
     */
    const anchor = title.replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim() || title;

    const better: MediaUpgradeCandidate[] = [];
    for (const c of run.candidates) {
      if (!showTitleMatch(anchor, c.title)) continue;
      const evaluation = evaluatePreferenceList(prefs, { title: c.title, sizeBytes: c.sizeBytes ?? null });
      if (!evaluation.matched || !evaluation.matchedCandidateId) continue;

      /*
       * Join on the candidate ID, never on `matchedCandidatePriority`.
       * That field is the acquisition candidate's `priorityOrder`, while a
       * normalized rung's index is its position in the ladder array; the two
       * coincide only when the array happens to be pre-sorted. Joining on the
       * number would silently compare the wrong rungs.
       */
      const rung = rungById.get(evaluation.matchedCandidateId);
      if (!rung) continue;
      // STRICTLY better. An equal rung is not an upgrade, which is what stops
      // a codec-only difference from proposing a re-download.
      if (rung.rung >= ownedRung) continue;

      better.push(this.toCandidate(c, rung, evaluation.parsed, facts));
      if (better.length >= MAX_UPGRADE_CANDIDATES * 3) break;
    }

    // Best rung first, then the healthiest swarm. Bounded before it is
    // returned, and bounded again before it is stored.
    better.sort((a, b) => (a.matchedRung ?? 99) - (b.matchedRung ?? 99) || (b.seeders ?? 0) - (a.seeders ?? 0));
    const candidates = better.slice(0, MAX_UPGRADE_CANDIDATES);

    return {
      status: candidates.length ? 'verified' : 'no_match',
      candidates,
      checkedAt: now.toISOString(),
      indexersQueried: run.queried,
      indexersFailed: run.failed,
    };
  }

  /**
   * The ladder acquisition itself would apply, as engine candidates.
   *
   * Scoped by media kind through the SAME predicate the quality evaluator
   * uses. This is not defensive decoration: an unscoped ladder here would
   * judge a film against TV rungs, and on this installation that mistake
   * marked 3,026 of 3,351 movies `below_preference` on size alone — a 1 GB
   * per-EPISODE cap applied to a feature. Returning nothing is the honest
   * answer when no configured rung governs this kind of media.
   */
  private async preferenceCandidates(
    entityType: MediaIntelligenceEntityType,
  ): Promise<MatchCandidateInput[]> {
    const kind = entityType === 'movie' ? ('movie' as const) : ('tv' as const);
    // `defaults()` IS the global ladder, which is primary in this repository;
    // the resolver owns the cascade and this file must not re-derive it.
    const rungs = await this.preferences.defaults();
    return ladderAppliesTo(rungs, kind) ? rungs : [];
  }

  /**
   * One searched release, normalized for display.
   *
   * Deliberately NOT the provider payload: no `downloadUrl`, no infoHash, no
   * raw JSON. An indexer link can carry an authentication token, and this
   * object is rendered in a browser and persisted.
   */
  private toCandidate(
    c: { title: string; indexerName: string; sizeBytes: number | null; seeders: number | null },
    rung: { rung: number; name: string },
    parsed: { resolution?: string; source?: string; codec?: string },
    facts: { quality?: { compliance: { matchedRung: number | null } } },
  ): MediaUpgradeCandidate {
    const meta = parseTorrentName(c.title);
    const owned = (facts as unknown as { quality?: { owned?: Record<string, unknown> } }).quality?.owned;

    /*
     * Only dimensions that are actually KNOWN on both sides are compared. An
     * owned file's source and release group do not survive import and rename,
     * so those stay null rather than being invented for symmetry — the same
     * boundary Phase 2 drew when it refused to synthesise a release name.
     */
    const dimensions: MediaCandidateDimension[] = [
      dim('resolution', (owned?.resolutionClass as string) ?? null, parsed.resolution ?? null),
      dim('codec', (owned?.videoCodec as string) ?? null, meta.codec ?? null),
      dim('source', null, parsed.source ?? null),
      dim('hdr', hdrLabel(owned?.hdr as boolean | null), meta.hdr?.length ? meta.hdr.join(', ') : null),
    ];

    return {
      releaseName: c.title,
      indexerName: c.indexerName,
      sizeBytes: c.sizeBytes,
      seeders: c.seeders,
      matchedRung: rung.rung,
      matchedRungName: rung.name,
      dimensions,
      // Stable codes, translated at presentation — never persisted prose.
      improvements: ['higher_preference_rung'],
      tradeoffs: [],
    };
  }

  /** Store the outcome so a reload shows it instead of re-searching. */
  private async persist(id: string, result: MediaVerificationResult, now: Date): Promise<void> {
    await this.prisma.mediaIntelligenceRecommendation.update({
      where: { id },
      data: {
        verification: result.status,
        verifiedAt: result.status === 'verified' ? now : null,
        // Only the best candidate is kept. This table is not an indexer
        // result archive, and the rest are re-derivable by asking again.
        candidate: result.candidates[0] ? (result.candidates[0] as unknown as object) : undefined,
        // A verified upgrade is worth more than an unverified suggestion.
        ...(result.status === 'verified'
          ? { confidence: 'high', confidenceRank: confidenceRank('high') }
          : {}),
      },
    });
  }

  private empty(status: MediaVerificationStatus, now: Date): MediaVerificationResult {
    return {
      status,
      candidates: [],
      checkedAt: now.toISOString(),
      indexersQueried: 0,
      indexersFailed: 0,
    };
  }
}

function dim(dimension: string, owned: string | null, candidate: string | null): MediaCandidateDimension {
  return {
    dimension,
    owned,
    candidate,
    // Improvement is claimed only when BOTH sides are known. An unknown owned
    // value must never read as "the candidate is better".
    improved: owned != null && candidate != null && owned !== candidate,
  };
}

/** Tri-state HDR, rendered honestly: null means colour was never measured. */
function hdrLabel(hdr: boolean | null | undefined): string | null {
  if (hdr == null) return null;
  return hdr ? 'HDR' : 'SDR';
}

/**
 * Indexers match against the release NAME, which carries no apostrophes —
 * "Grey's Anatomy" ships as `Greys.Anatomy...`, so an apostrophe in the query
 * matches nothing at all. The same normalization acquisition already applies.
 */
function searchTermFor(title: string): string {
  return title.replace(/['’]/g, '').trim();
}
