import { readdir, stat } from 'node:fs/promises';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { WantedEpisode } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { IndexerService } from '../indexers/indexer.service';
import { AcquisitionEvaluatorService } from './evaluator.service';
import { AcquisitionMatchPreferenceService } from './acquisition-match-preference.service';
import { MediaAcquisitionService } from './media-acquisition.service';
import { MEDIA_ACQUISITION_MODULE_ID } from './decision.engine';
import { showFolderRoot } from '../media/media-renamer';
import { showCanonicalKey } from '../media/series-grouping';
import { normalize } from '../rss/match-engine';
import { StorageProfileService } from '../media-intake/storage-profile.service';

/** A rule in this mode stages its downloads for the intake pipeline. */
const MANAGED_RSS_IMPORT_MODE = 'managed_intake';

type WantedSearchStatus = 'idle' | 'searching' | 'grabbed' | 'pending_approval' | 'no_results' | 'failed';

/** The media types a TV show's files are filed under. */
const SHOW_MEDIA_TYPES = ['tv', 'anime', 'episode'];

/** Every canonical key a watchlist item answers to — its title plus any alias. */
function showKeys(item: { title: string; titleAliases?: string[] | null }): Set<string> {
  const keys = new Set<string>();
  for (const t of [item.title, ...(item.titleAliases ?? [])]) {
    const k = showCanonicalKey(t ?? '');
    if (k) keys.add(k);
  }
  return keys;
}

export interface EpisodeSearchOutcome {
  wantedEpisodeId: string;
  searchStatus: WantedSearchStatus;
  releaseTitle?: string;
  evaluationId?: string;
}

/**
 * The missing-episode auto-acquire bridge: for each `missing` WantedEpisode it
 * searches the configured Torznab/Newznab indexers and picks a release using the
 * **auto-download match preferences** ({@link AcquisitionMatchPreferenceService})
 * — the show's RSS rule filters first, else its auto-download profiles, else the
 * global defaults — then grabs the winner via
 * {@link AcquisitionEvaluatorService.grabSelected}. Nothing matches the
 * preferences → `no_results`; no resolvable library path → `failed` (never a grab
 * into the engine's default root). Grab-state is written back onto the
 * WantedEpisode (and preserved across rescans).
 *
 * The scheduled `sweep()` is opt-in (`settings.autoSearchMissing`, default OFF);
 * the manual triggers run whenever the module is enabled.
 */
@Injectable()
export class MissingEpisodeSearchService {
  private readonly logger = new Logger(MissingEpisodeSearchService.name);
  private searching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexers: IndexerService,
    private readonly evaluator: AcquisitionEvaluatorService,
    private readonly matchPrefs: AcquisitionMatchPreferenceService,
    private readonly acquisition: MediaAcquisitionService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ModuleRegistryService,
    private readonly profiles: StorageProfileService,
  ) {}

  private get enabled(): boolean {
    return this.registry.getStatus(MEDIA_ACQUISITION_MODULE_ID)?.enabled ?? false;
  }

  /**
   * Scheduled sweep. No-op unless the module is enabled AND the operator opted in
   * (`autoSearchMissing`). Re-entrancy guarded; processes a bounded, oldest-first
   * batch and applies a per-episode backoff so it doesn't hammer indexers.
   */
  async sweep(): Promise<{ scanned: number; grabbed: number; pendingApproval: number; noResults: number } | null> {
    if (!this.enabled || this.searching) return null;
    const settings = await this.acquisition.getSettings();
    if (!settings.autoSearchMissing) return null;

    this.searching = true;
    try {
      const cutoff = new Date(Date.now() - (settings.searchIntervalMinutes ?? 60) * 60_000);
      const rows = await this.prisma.wantedEpisode.findMany({
        where: {
          status: 'missing',
          OR: [
            { searchStatus: 'idle' },
            { searchStatus: { in: ['no_results', 'failed'] }, lastSearchedAt: { lt: cutoff } },
            { searchStatus: { in: ['no_results', 'failed'] }, lastSearchedAt: null },
          ],
        },
        orderBy: { lastSearchedAt: { sort: 'asc', nulls: 'first' } },
        take: settings.maxSearchesPerSweep ?? 50,
      });

      const summary = { scanned: 0, grabbed: 0, pendingApproval: 0, noResults: 0 };
      for (const row of rows) {
        try {
          const outcome = await this.processEpisode(row, settings.missingSearchProfileId);
          summary.scanned += 1;
          if (outcome.searchStatus === 'grabbed') summary.grabbed += 1;
          else if (outcome.searchStatus === 'pending_approval') summary.pendingApproval += 1;
          else summary.noResults += 1;
        } catch (err) {
          this.logger.warn(`Search failed for wanted episode ${row.id}: ${(err as Error).message}`);
          await this.setState(row.id, { searchStatus: 'failed', lastSearchedAt: new Date() });
        }
      }
      if (summary.scanned) {
        this.logger.log(`Missing-episode sweep: ${summary.scanned} searched, ${summary.grabbed} grabbed, ${summary.pendingApproval} pending approval`);
      }
      return summary;
    } finally {
      this.searching = false;
    }
  }

  /** Manual: search one wanted episode now (bypasses the autoSearchMissing gate). */
  async searchEpisode(wantedEpisodeId: string, userId?: string): Promise<EpisodeSearchOutcome> {
    if (!this.enabled) throw new BadRequestException('Media Acquisition module is disabled');
    const row = await this.prisma.wantedEpisode.findUnique({ where: { id: wantedEpisodeId } });
    if (!row) throw new NotFoundException('Wanted episode not found');
    if (row.status !== 'missing') throw new BadRequestException(`Episode is "${row.status}", not missing`);
    const settings = await this.acquisition.getSettings();
    return this.processEpisode(row, settings.missingSearchProfileId, userId);
  }

  /** Manual: search every missing episode of one monitored series now. */
  async searchSeries(watchlistItemId: string, userId?: string): Promise<{ results: EpisodeSearchOutcome[] }> {
    if (!this.enabled) throw new BadRequestException('Media Acquisition module is disabled');
    const settings = await this.acquisition.getSettings();
    const rows = await this.prisma.wantedEpisode.findMany({
      where: { watchlistItemId, status: 'missing' },
      orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
    });
    const results: EpisodeSearchOutcome[] = [];
    for (const row of rows) {
      try {
        results.push(await this.processEpisode(row, settings.missingSearchProfileId, userId));
      } catch (err) {
        this.logger.warn(`Search failed for wanted episode ${row.id}: ${(err as Error).message}`);
        await this.setState(row.id, { searchStatus: 'failed', lastSearchedAt: new Date() });
        results.push({ wantedEpisodeId: row.id, searchStatus: 'failed' });
      }
    }
    return { results };
  }

  // --- core -----------------------------------------------------------------

  private async processEpisode(
    wanted: WantedEpisode,
    _settingsProfileId: string | null,
    userId?: string,
  ): Promise<EpisodeSearchOutcome> {
    await this.setState(wanted.id, { searchStatus: 'searching' });

    const item = await this.prisma.mediaAcquisitionWatchlistItem.findUnique({
      where: { id: wanted.watchlistItemId },
    });
    if (!item) throw new NotFoundException('Watchlist item not found');

    // Download directory: the show's folder under its media library. Resolving it
    // is mandatory — without it the engine would drop the episode in its default
    // root (loose files at /downloads instead of the show folder), so a grab we
    // cannot place is refused rather than misfiled.
    const { path: savePath, intakeRuleId } = await this.resolveSavePath(item, wanted.seriesTconst);
    if (!savePath) {
      const reason =
        `No save path for "${item.title}": no Show Rule savePath, no existing library ` +
        `folder, and no TV library configured. Refusing to grab into the engine's default root.`;
      this.logger.warn(reason);
      await this.setState(wanted.id, { searchStatus: 'failed', lastSearchedAt: new Date() });
      await this.audit.record({
        userId,
        action: 'media_acquisition.missing_episode.no_save_path',
        objectType: 'wanted_episode',
        objectId: wanted.id,
        result: 'failure',
        metadata: { title: item.title, season: wanted.seasonNumber, episode: wanted.episodeNumber },
      });
      return { wantedEpisodeId: wanted.id, searchStatus: 'failed' };
    }

    /*
     * Ask more than once, in widening forms, until something answers.
     *
     * Indexers tokenize a query; punctuation in the stored title does not survive
     * that. Searching "9-1-1" returns nothing on EZTV or TPB while "9 1 1" — and
     * sometimes only "9 1 1 2018" — returns the same releases the library is full
     * of. The show is not missing from the trackers; the question was unaskable.
     *
     * Aliases join in here too. They were already passed to the selector, so an
     * alias could VALIDATE a release but never go and look for one, which is the
     * wrong half of the job for a title nobody can spell.
     */
    const queries = this.searchQueriesFor(item);
    let run: Awaited<ReturnType<typeof this.indexers.searchAllDetailed>> | null = null;
    let outage = false;
    for (const q of queries) {
      run = await this.indexers.searchAllDetailed({
        q,
        season: wanted.seasonNumber,
        ep: wanted.episodeNumber,
      });
      // Nothing could look. Stop — retrying the same dead indexers with a
      // different spelling only multiplies the failures.
      if (run.queried > 0 && run.failed === run.queried) {
        outage = true;
        break;
      }
      if (run.candidates.length) {
        if (q !== queries[0]) {
          this.logger.log(
            `"${item.title}" S${wanted.seasonNumber}E${wanted.episodeNumber}: ` +
              `no results for "${queries[0]}", found ${run.candidates.length} for "${q}".`,
          );
        }
        break;
      }
      /*
       * Nothing found, but not everything could look either. Do NOT widen.
       *
       * Widening is a bet that the release exists under a different spelling, and
       * an empty answer from a degraded search is no evidence for or against that
       * — it is just an unanswered question. Spending two more requests on it is
       * worst when it is least affordable: the usual reason an indexer fails here
       * is HTTP 429, and the fix for being rate-limited is never to ask more.
       *
       * Observed on a live install: EZTV and TPB both throttled to 429 while
       * ShowRSS answered emptily, so every episode looked like a clean miss and
       * every miss triggered the full widening — tripling traffic into the
       * service already refusing it.
       */
      if (run.failed > 0) {
        this.logger.debug(
          `Not widening the search for "${item.title}" ` +
            `S${wanted.seasonNumber}E${wanted.episodeNumber}: ${run.failed}/${run.queried} ` +
            `indexer(s) failed, so an empty result is not evidence the spelling is wrong.`,
        );
        break;
      }
    }
    if (!run) {
      // searchQueriesFor cannot return empty for a titled item, so this means the
      // item has no usable title at all.
      await this.setState(wanted.id, { searchStatus: 'no_results', lastSearchedAt: new Date() });
      return { wantedEpisodeId: wanted.id, searchStatus: 'no_results' };
    }
    // Every indexer failing is NOT "no results" — it is "nothing could look", and
    // recording it as the former is a lie the operator acts on. Observed live: with
    // EZTV and The Pirate Bay both in Prowlarr failure backoff, 113 missing *9-1-1*
    // episodes were each stamped `no_results`, which reads as "this release does not
    // exist" when the search never actually happened. `failed` is the honest state
    // (it retries on the same backoff, so nothing is lost by telling the truth).
    if (outage) {
      const detail = run.failures.map((f) => `${f.name}: ${f.message}`).join('; ');
      this.logger.warn(
        `All ${run.queried} indexer(s) failed searching "${item.title}" ` +
          `S${wanted.seasonNumber}E${wanted.episodeNumber} — recording as failed, not no_results. ${detail}`,
      );
      await this.setState(wanted.id, { searchStatus: 'failed', lastSearchedAt: new Date() });
      await this.audit.record({
        userId,
        action: 'media_acquisition.missing_episode.indexers_unavailable',
        objectType: 'wanted_episode',
        objectId: wanted.id,
        result: 'failure',
        metadata: {
          title: item.title,
          season: wanted.seasonNumber,
          episode: wanted.episodeNumber,
          indexersQueried: run.queried,
          failures: run.failures,
        },
      });
      return { wantedEpisodeId: wanted.id, searchStatus: 'failed' };
    }
    const candidates = run.candidates;
    // Match preferences decide which release to grab: the show's RSS rule filters
    // when it has any, else the auto-download profiles, else the global defaults.
    const prefs = await this.matchPrefs.resolveCandidates(item);
    const best = this.matchPrefs.select(
      candidates,
      prefs,
      item.title,
      wanted.seasonNumber,
      wanted.episodeNumber,
      item.titleAliases ?? [],
      // Releases this episode already proved dead — see WantedSearchReconciler.
      wanted.deadReleases ?? [],
    );

    if (!best) {
      // Nothing matched the preferences (e.g. everything over the size cap).
      await this.setState(wanted.id, { searchStatus: 'no_results', lastSearchedAt: new Date() });
      return { wantedEpisodeId: wanted.id, searchStatus: 'no_results' };
    }

    const rel = best.candidate;
    const { evaluation, torrentHash } = await this.evaluator.grabSelected(
      {
        releaseName: rel.title,
        downloadUrl: rel.downloadUrl ?? undefined,
        sizeBytes: rel.sizeBytes ?? undefined,
        seeders: rel.seeders ?? undefined,
        watchlistItemId: item.id,
        sourceType: 'missing_episode_sweep',
        sourceId: wanted.id,
        priority: item.priority,
        reason: best.reason,
        savePath,
      },
      userId,
    );

    const now = new Date();
    /*
     * The engine returns no hash when the add itself failed, and `select()` only
     * ever picks candidates that HAVE a downloadUrl, so a null here is a genuine
     * failure rather than an advisory evaluation.
     *
     * Stamping `grabbed` regardless is how 32 episodes on a live install came to
     * sit against a download action whose status was `failed` and whose result was
     * null — no torrent was ever added, but the sweep selects only idle/no_results/
     * failed, so each was permanently excluded from ever being searched again.
     * Claiming success for something that failed is worse than the failure.
     */
    if (!torrentHash) {
      this.logger.warn(
        `Grab failed for "${item.title}" S${wanted.seasonNumber}E${wanted.episodeNumber} ` +
          `("${rel.title}"): the engine accepted no torrent. Recording as failed so it is retried.`,
      );
      await this.setState(wanted.id, {
        searchStatus: 'failed',
        lastSearchedAt: now,
        grabbedEvaluationId: evaluation.id,
      });
      return { wantedEpisodeId: wanted.id, searchStatus: 'failed', evaluationId: evaluation.id };
    }
    await this.setState(wanted.id, {
      searchStatus: 'grabbed',
      lastSearchedAt: now,
      grabbedAt: now,
      grabbedEvaluationId: evaluation.id,
      downloadUrl: rel.downloadUrl,
      releaseTitle: rel.title,
      // What lets Media Intake find this download later. `intakeRuleId` is only
      // set when the grab was actually sent to staging, so a null here means
      // "went to the library", and the trigger correctly leaves it alone.
      torrentHash,
      intakeRuleId,
    });
    this.broadcastGrabbed(wanted, rel.title, evaluation.id);
    await this.audit.record({
      userId,
      action: 'media_acquisition.missing_episode.grabbed',
      objectType: 'wanted_episode',
      objectId: wanted.id,
      metadata: { releaseTitle: rel.title, evaluationId: evaluation.id, via: 'match_preferences' },
    });
    return { wantedEpisodeId: wanted.id, searchStatus: 'grabbed', releaseTitle: rel.title, evaluationId: evaluation.id };
  }

  /**
   * The download directory for a grabbed episode, and the rule that decided it.
   *
   * The show's **own RSS rule wins** — linked by `rssRuleId`, else matched by
   * canonical name. A rule is a deliberate statement by the operator about where
   * that show belongs, and the whole point of configuring one is that acquisitions
   * follow it. Two subsystems disagreeing about a show's directory is how episodes
   * end up split across two folders.
   *
   * A rule only wins if its directory **exists on disk**. A `savePath` left behind
   * by a rename points somewhere nothing scans, and honouring it blindly would
   * recreate a dead folder and quietly file episodes into it; the library-observed
   * answer below is better than a stale one.
   *
   * When that rule is in `managed_intake` the answer is its storage profile's
   * **staging root**, not the library — the file is meant to land in staging and be
   * placed by the intake pipeline. See {@link stagingPathFor}.
   *
   * With no usable rule it falls back to the library, in the order that was already
   * here:
   *
   *   1. the **library show this item is bound to** — a path the scanner recorded
   *      from disk. Not a guess: no titles compared, nothing constructed;
   *   2. else the library folder of the item carrying the show's **IMDb id**;
   *   3. else the library folder of an item whose **title matches the show**;
   *   4. else an **existing show folder** already sitting in the target library;
   *   5. else, and only then, a constructed `<TV library>/<Title> (Year)`.
   *
   * Name comparisons use canonical keys (punctuation- and case-insensitive,
   * trailing year stripped) against the item's title *and its aliases*, by
   * equality and never substring, so "Ghosts US" cannot collide with "Ghosts UK".
   *
   * Step 5 is the dangerous one — it invents a directory named after whatever the
   * watchlist entry happens to be called. Two duplicate entries for the same show,
   * titled "Ghosts 2021" and "Ghosts (US)", once minted
   * `TV Shows/Ghosts 2021 (2021)` and `TV Shows/Ghosts (US) (2021)` beside the real
   * `TV Shows/Ghosts US (2021)`. Steps 1, 2 and 4 are what keep it unreachable for
   * a show the library already knows about — promoting the rule above them does not
   * weaken that, because a rule path is configured, never constructed.
   *
   * Returns `path: undefined` only when nothing resolves — the caller then refuses
   * the grab, because falling through to the engine's default would scatter
   * episodes loose in the download root instead of the show's folder.
   */
  private async resolveSavePath(
    item: {
      id?: string;
      rssRuleId: string | null;
      libraryShowId?: string | null;
      title: string;
      titleAliases?: string[] | null;
      year: number | null;
      targetLibraryId: string | null;
    },
    seriesTconst?: string | null,
  ): Promise<{ path?: string; intakeRuleId: string | null }> {
    // 0. The show's own rule, which outranks everything below it.
    const rule = await this.resolveRule(item);
    if (rule) {
      if (rule.importMode === MANAGED_RSS_IMPORT_MODE) {
        const staging = await this.stagingPathFor(rule, item);
        // No profile resolved: staging would be a guess, and a managed grab sent
        // to the library instead is silently the old behaviour. Fall through to
        // the library and say so — an operator can see it and fix the profile.
        if (staging) return { path: staging, intakeRuleId: rule.id };
        this.logger.warn(
          `Rule "${rule.name}" is managed_intake but no storage profile resolved; ` +
            `filing "${item.title}" into the library as before.`,
        );
      } else {
        const sp = rule.savePath?.trim();
        if (sp && (await this.isDirectory(sp))) return { path: sp, intakeRuleId: null };
        if (sp) {
          this.logger.warn(
            `Rule "${rule.name}" savePath "${sp}" does not exist; resolving ` +
              `"${item.title}" from the library instead.`,
          );
        }
      }
    }

    const path = await this.resolveLibraryPath(item, seriesTconst);
    return { path, intakeRuleId: null };
  }

  /**
   * The queries to try for one episode, widest last.
   *
   *   1. every title as written — the show's own, then each alias;
   *   2. the same, punctuation stripped;
   *   3. the same again with the year appended.
   *
   * Indexers tokenize; a stored "9-1-1" is not the "9 1 1" their index holds, so
   * the exact title finds nothing while the stripped form finds everything. The
   * year is last because it narrows: it rescues a title too generic to search on
   * its own, and would otherwise exclude releases that simply do not carry it.
   *
   * `normalize` is the match engine's — the same function the SELECTOR uses to
   * decide whether a returned release is this show. Asking and answering in one
   * vocabulary is the point; a query form the validator would reject is wasted.
   * It elides apostrophes rather than splitting on them, so "Happy's Place"
   * becomes "happys place" and matches the wire, not "happy s place".
   *
   * Ordered widest-last and stopped at the first query with results, so a show
   * that already works issues exactly the one query it always did.
   */
  private searchQueriesFor(item: { title: string; titleAliases?: string[] | null; year: number | null }): string[] {
    const out: string[] = [];
    const push = (q: string | null | undefined) => {
      const v = q?.trim();
      if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    };
    const titles = [item.title, ...(item.titleAliases ?? [])].filter(Boolean);
    for (const t of titles) push(t);
    for (const t of titles) push(normalize(t));
    if (item.year) for (const t of titles) push(`${normalize(t)} ${item.year}`);
    return out;
  }

  /**
   * The show's rule: the explicit link first, else one whose name canonicalizes to
   * the same key as the show's title or any of its aliases.
   *
   * Shared by the destination decision and (via the recorded `intakeRuleId`) the
   * import that follows, so the two cannot reach different answers about which
   * rule governs a grab.
   */
  private async resolveRule(item: {
    rssRuleId: string | null;
    title: string;
    titleAliases?: string[] | null;
  }) {
    const select = { id: true, name: true, savePath: true, importMode: true, storageProfileId: true };
    if (item.rssRuleId) {
      const linked = await this.prisma.rssRule.findUnique({ where: { id: item.rssRuleId }, select });
      if (linked) return linked;
    }
    const keys = showKeys(item);
    if (!keys.size) return null;
    const rules = await this.prisma.rssRule.findMany({ select });
    return rules.find((r) => keys.has(showCanonicalKey(r.name))) ?? null;
  }

  /**
   * Where a managed-intake grab is downloaded: a per-show directory under the
   * profile's staging root.
   *
   * Per-show rather than a flat staging root because several episodes of different
   * shows land concurrently, and intake identifies a job by its source path — one
   * shared directory makes those paths collide and two intakes fight over the same
   * folder.
   */
  private async stagingPathFor(
    rule: { storageProfileId: string | null },
    item: { title: string; year: number | null },
  ): Promise<string | undefined> {
    const profile = rule.storageProfileId
      ? await this.profiles.get(rule.storageProfileId).catch(() => null)
      : await this.profiles.defaultProfile();
    const root = profile?.stagingRoot?.trim().replace(/\/+$/, '');
    if (!root) return undefined;
    const folder = item.year ? `${item.title} (${item.year})` : item.title;
    return `${root}/${folder}`;
  }

  /** The library-observed chain, unchanged apart from losing the rule steps. */
  private async resolveLibraryPath(
    item: {
      id?: string;
      libraryShowId?: string | null;
      title: string;
      titleAliases?: string[] | null;
      year: number | null;
      targetLibraryId: string | null;
    },
    seriesTconst?: string | null,
  ): Promise<string | undefined> {
    // 0. The library show this item is bound to. Recorded from disk by the scanner,
    //    so there is nothing to match and nothing to build.
    if (item.libraryShowId) {
      const show = await this.prisma.mediaShow.findUnique({
        where: { id: item.libraryShowId },
        select: { path: true, title: true },
      });
      if (show?.path) return show.path;
      // The row is gone (folder removed, library deleted). The FK is SET NULL, so
      // this is rare; fall through to resolving by name rather than refuse.
      this.logger.warn(
        `Watchlist item "${item.title}" points at library show ${item.libraryShowId}, which no longer exists — resolving its folder by name instead.`,
      );
    }

    // Rule resolution happened in resolveSavePath, above this chain.
    const keys = showKeys(item);

    // 2. The library folder holding this show's IMDb id. Titles can disagree with
    //    the library in any number of ways; the id cannot.
    //
    //    Unless the id itself is wrong. Real libraries carry mis-tagged items —
    //    "Masters of the Air" was found tagged with High Desert's tt13701758 — and a
    //    naive lookup would then file High Desert's episodes into the Masters of the
    //    Air folder. So the id is only trusted when it points at exactly ONE show
    //    folder that still exists on disk; anything else is ambiguous and we fall
    //    through to matching on names.
    if (seriesTconst) {
      const rows = await this.prisma.mediaExternalId.findMany({
        where: {
          provider: 'imdb',
          externalId: seriesTconst,
          item: { mediaType: { in: SHOW_MEDIA_TYPES } },
        },
        select: { item: { select: { path: true } } },
      });
      const folders = [...new Set(rows.map((r) => this.folderOf(r.item?.path)).filter(Boolean))];
      // Folders the library still has rows for but that were since deleted or
      // merged away are not candidates — that is how the stale Ghosts rows look.
      const live: string[] = [];
      for (const f of folders) if (await this.isDirectory(f as string)) live.push(f as string);

      if (live.length === 1) return live[0];
      if (live.length > 1) {
        this.logger.warn(
          `IMDb id ${seriesTconst} maps to ${live.length} show folders (${live.join(', ')}) — ` +
            `the library metadata is inconsistent. Ignoring the id and matching on the title instead.`,
        );
      }
    }

    // 4. A library item whose title matches the show. The canonical comparison
    //    cannot be pushed into SQL, so we pull one row per distinct show title
    //    (hundreds, not the tens of thousands of episode rows behind them).
    if (keys.size) {
      const rows = await this.prisma.mediaItem.findMany({
        where: { mediaType: { in: SHOW_MEDIA_TYPES } },
        select: { title: true, path: true },
        distinct: ['title'],
      });
      const hit = rows.find((r) => keys.has(showCanonicalKey(r.title)));
      const folder = this.folderOf(hit?.path);
      if (folder) return folder;
    }

    // 5/6. Resolve the library, then prefer a show folder that already exists in it
    //      over inventing a new one.
    const library = item.targetLibraryId
      ? await this.prisma.mediaLibrary.findUnique({
          where: { id: item.targetLibraryId },
          select: { path: true },
        })
      : await this.prisma.mediaLibrary.findFirst({
          where: { kind: { in: ['tv', 'anime'] } },
          select: { path: true },
          orderBy: { createdAt: 'asc' },
        });
    const libraryPath = library?.path?.trim().replace(/\/+$/, '');
    if (!libraryPath) return undefined;

    // 5. An existing folder in the library that IS this show, under any spelling.
    const existingFolder = await this.findShowFolder(libraryPath, keys);
    if (existingFolder) return existingFolder;

    // 6. Nothing on disk for this show — a new folder is genuinely warranted.
    const folderName = item.year ? `${item.title} (${item.year})` : item.title;
    return `${libraryPath}/${folderName}`;
  }

  /** Whether `p` is a directory that exists right now. */
  private async isDirectory(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  /** A library item's show folder (climbed past any `Season NN` container). */
  private folderOf(path: string | null | undefined): string | undefined {
    if (!path) return undefined;
    const folder = showFolderRoot(path);
    return folder && folder !== '.' && folder !== '/' ? folder : undefined;
  }

  /**
   * A directory directly under `libraryPath` whose name canonicalizes to one of
   * `keys` — i.e. the show already has a folder, whatever it happens to be named
   * ("Ghosts US (2021)" answers for a watchlist entry titled "Ghosts (US)").
   *
   * An unreadable library path is not fatal: we fall through to constructing,
   * which is the pre-existing behaviour.
   */
  private async findShowFolder(libraryPath: string, keys: Set<string>): Promise<string | undefined> {
    if (!keys.size) return undefined;
    let entries;
    try {
      entries = await readdir(libraryPath, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const hit = entries.find((e) => e.isDirectory() && keys.has(showCanonicalKey(e.name)));
    return hit ? `${libraryPath}/${hit.name}` : undefined;
  }

  /**
   * Update one wanted episode's search state. Uses `updateMany` (not `update`) so
   * a row that vanished mid-sweep is a no-op (`count: 0`) instead of throwing
   * "Record to update not found": a concurrent library/watchlist scan deletes and
   * recreates the WantedEpisode rows, and a plain `update` on a since-deleted id
   * would abort the whole sweep tick (its per-episode error handler calls
   * `setState` too, so the throw escapes the loop).
   */
  private setState(id: string, data: Partial<WantedEpisode>): Promise<unknown> {
    return this.prisma.wantedEpisode.updateMany({ where: { id }, data });
  }

  /** Tell any open Missing Episodes view that this episode was grabbed. */
  private broadcastGrabbed(wanted: WantedEpisode, releaseTitle: string, evaluationId: string): void {
    this.realtime.broadcast('media_acquisition.missing_episode.grabbed', {
      watchlistItemId: wanted.watchlistItemId,
      seriesTconst: wanted.seriesTconst,
      seasonNumber: wanted.seasonNumber,
      episodeNumber: wanted.episodeNumber,
      releaseTitle,
      evaluationId,
    });
  }
}
