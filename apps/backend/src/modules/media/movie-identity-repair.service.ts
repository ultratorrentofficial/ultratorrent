import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MetadataProviderRegistry } from './metadata-provider-registry.service';

/**
 * Repair movie identities written by the unverified TMDB lookup.
 *
 * `/search/movie` ranks by popularity, and the lookup used to take `results[0]`.
 * A short title matched a famous longer one, and the wrong film's identity was
 * written into the item — so on the live library ONE imdb id, `tt1790864`, is
 * held by three different films: `The Maze Runner (2014)`, `Maze (2017)` and
 * `The Runner (2015)`. Twenty-nine ids are contaminated that way across sixty
 * items.
 *
 * The consequence is not cosmetic. The Duplicate Center groups on external id,
 * so each contaminated id surfaces as a "duplicate" whose members are DIFFERENT
 * FILMS — and acting on the recommendation deletes one of them while reporting
 * reclaimed space. The engine is faithful; its input is a lie.
 *
 * Two things make the repair tractable:
 *
 *  - **The folder is trustworthy.** `rename_in_place` never rewrites the show or
 *    movie folder, so `Maze (2017)/` still names the film it holds even though
 *    the file inside was renamed `The Maze Runner (2014) - 1080p.mp4`. Identity
 *    is therefore re-derived from the folder, never from the filename or the
 *    stored title.
 *  - **No id beats a wrong id.** When re-identification cannot verify a match we
 *    DROP the existing id rather than keep it. That is not a new judgement: it is
 *    what `pickBestMovie` already documents ("a movie with no external id is
 *    correct-but-incomplete, while a movie with the WRONG id corrupts detection,
 *    dedup and every downstream lookup") and what `isForeignEpisodeId` already
 *    does for TV, where one episode id claimed by two show folders is deleted
 *    from both.
 *
 * With one refinement, because "cannot verify" hides two different situations. A
 * BLANK — nothing matched — says the stored id is unsupported, so it goes. A TIE
 * — several real films share the title and year (TMDB holds three different
 * `Aladdin (1992)` and five different `Run (2020)`) — says the query is not
 * specific enough to choose, which is not evidence against the id already stored.
 * So when the stored id is one of the tied films it is KEPT, and cleared only
 * when it is not among them. Measured over the live contaminated set the split
 * was clean: every stored id that appeared in its tied set was the right film,
 * and every one that did not was the contaminant. Nothing is guessed either way —
 * the alternative, breaking the tie by popularity, is the exact reflex that
 * caused this corruption.
 *
 * Deliberately identity-only. Once the ids are right the ordinary rename flow
 * produces correct filenames, so this service never touches a file — which keeps
 * a repair that can be re-run and reviewed separate from one that moves bytes.
 */

/**
 * Tokens that end a title and begin the release noise.
 *
 * Kept small and unambiguous on purpose. Every entry here is a word that cannot
 * plausibly be part of a film's name, because a false positive TRUNCATES a title
 * ("Once Upon a Time in Hollywood" losing everything after a matched word) and a
 * truncated title verifies against the wrong film — the exact failure being
 * repaired. A missed tag merely leaves junk on the end, which the title+year gate
 * then rejects safely. So when in doubt, leave it out.
 */
const RELEASE_TAG =
  /^(?:\d{3,4}p|4k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-?dl|hdtv|dvdrip|remux|hdrip|x26[45]|h\.?26[45]|hevc|xvid|divx|aac\d?|ac3|eac3|dd[p+]?\d?|dts(?:-hd)?|truehd|atmos|10bit|hdr\d*|sdr|proper|repack|remastered|imax|yts(?:\.\w+)?|yify|rarbg)$/i;

export interface RepairProposal {
  itemId: string;
  path: string;
  /** What the FOLDER says this film is — the signal being trusted. */
  folderTitle: string;
  folderYear: number | null;
  /** Provider → id currently stored (the possibly-wrong identity). */
  current: Record<string, string>;
  /** Provider → id after re-identification. Empty means "drop what is there". */
  proposed: Record<string, string>;
  action: 'reidentify' | 'clear' | 'unchanged';
  /**
   * Several real films share this folder's title and year, so the identity rests
   * on the stored id being one of them rather than on a verified match. Surfaced
   * because it is the one class of proposal a human should look at.
   */
  ambiguous: boolean;
  /** Why, in one line, for the preview table. */
  reason: string;
}

/**
 * A folder's identity as the providers see it: what verified, or — when nothing
 * did — the several films that tied. The two are exclusive; `tied` is only
 * populated when `ids` is empty, because a clean win leaves no question open.
 */
interface FolderIdentity {
  ids: Record<string, string>;
  tied: Array<Record<string, string>>;
}

export interface RepairPlan {
  /** External ids each claimed by more than one movie folder. */
  contaminatedIds: number;
  proposals: RepairProposal[];
}

@Injectable()
export class MovieIdentityRepairService {
  private readonly logger = new Logger(MovieIdentityRepairService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: MetadataProviderRegistry,
  ) {}

  /** The folder that names a movie — its parent directory. */
  private folderOf(p: string): string {
    return path.basename(path.dirname(p));
  }

  /**
   * Split a movie folder into title and year.
   *
   * Deliberately NOT `parseTorrentName`: most movie folders are already canonical
   * (`Maze (2017)`), and the release parser would try to read episode markers out
   * of a name that has none — the same over-reading that made a show folder parse
   * as a movie in the first place. But "most" is not "all", so this does the one
   * thing the release parser is genuinely needed for: ignore the trailing junk a
   * scene folder carries.
   *
   * `Midas Man (2024) [BLURAY] [1080p] [BluRay] [5.1] [YTS.MX]` used to yield the
   * whole string as the title and NO year, and a title like that verifies against
   * nothing — so the folder the repair most needs to read correctly was the one it
   * read worst, and a good film would have had its id cleared for want of a parse.
   */
  parseFolder(name: string): { title: string; year: number | null } {
    // Bracketed groups are metadata, never title: scene tags (`[1080p]`) and the
    // Plex/Emby id convention (`{tvdb-396564}`, `{edition-Director's Cut}`) alike.
    // …unless stripping is all there was, in which case the brackets WERE the name
    // and the raw folder is the only thing left to report.
    const stripped = name.replace(/[[{][^\]}]*[\]}]/g, ' ').replace(/\s+/g, ' ').trim() || name.trim();

    // The canonical form, wherever it sits: the FIRST parenthesised year wins and
    // everything after it is noise. Lazy prefix so `2012 (2009)` reads as the 2009
    // film titled "2012" rather than a 2012 film, and so a parenthesised edition
    // (`Alien (Director's Cut) (1979)`) stays part of the title it qualifies.
    const paren = /^(.*?)\s*\((\d{4})\)/.exec(stripped);
    if (paren && paren[1].trim()) return { title: paren[1].trim(), year: Number(paren[2]) };

    // No parenthesised year: walk the tokens and stop at the first one that is
    // demonstrably not part of the title — a bare year, or a release tag.
    const tokens = (stripped.includes(' ') ? stripped : stripped.replace(/\./g, ' ')).split(' ');
    const title: string[] = [];
    let year: number | null = null;
    for (const token of tokens) {
      // A leading year is a TITLE ("1917", "2012"), not a release year, so a token
      // only reads as the year once something precedes it.
      if (title.length && this.isPlausibleYear(token)) {
        year = Number(token);
        break;
      }
      if (title.length && RELEASE_TAG.test(token)) break;
      title.push(token);
    }
    return { title: title.join(' ').trim() || stripped, year };
  }

  /**
   * A 4-digit token in the range films are actually released in.
   *
   * The range is what keeps `Blade Runner 2049` a title: 2049 is not a year any
   * library holds, so the token stays where it belongs. Cinema starts in 1888
   * (Roundhay Garden Scene); the upper bound allows the pre-release window.
   */
  private isPlausibleYear(token: string): boolean {
    if (!/^\d{4}$/.test(token)) return false;
    const n = Number(token);
    return n >= 1888 && n <= new Date().getFullYear() + 2;
  }

  /**
   * Items whose external id is claimed by more than one movie folder.
   *
   * The shared id IS the evidence: two folders naming different films cannot
   * legitimately hold the same film. A single mis-identified item with no
   * colliding partner is not detected here — it is indistinguishable from a
   * correct one without asking a provider about every film in the library, which
   * is a far bigger and far more network-expensive sweep.
   *
   * A shared id SELECTS the item, but the `ids` returned are the item's COMPLETE
   * identity, contaminated or not. Two reasons, and both are bugs if it returns
   * only the guilty subset: `apply` replaces an item's ids wholesale, so a clean
   * id omitted here would be deleted along with the wrong one; and the tie check
   * compares against the stored tmdb id, which is unavailable if only the imdb
   * row happened to collide.
   */
  async contaminated(): Promise<
    Array<{ itemId: string; path: string; ids: Record<string, string>; guilty: string[] }>
  > {
    const rows = await this.prisma.mediaExternalId.findMany({
      where: { item: { path: { contains: '/Movies/' } } },
      select: { provider: true, externalId: true, itemId: true, item: { select: { path: true } } },
    });

    // provider|id -> distinct folders holding it
    const folders = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = `${r.provider}|${r.externalId}`;
      if (!folders.has(key)) folders.set(key, new Set());
      folders.get(key)!.add(this.folderOf(r.item.path));
    }
    const bad = new Set([...folders.entries()].filter(([, f]) => f.size > 1).map(([k]) => k));

    // Which items are implicated, then EVERY id each of them holds.
    const implicated = new Set(
      rows.filter((r) => bad.has(`${r.provider}|${r.externalId}`)).map((r) => r.itemId),
    );
    const byItem = new Map<
      string,
      { itemId: string; path: string; ids: Record<string, string>; guilty: string[] }
    >();
    for (const r of rows) {
      if (!implicated.has(r.itemId)) continue;
      if (!byItem.has(r.itemId)) {
        byItem.set(r.itemId, { itemId: r.itemId, path: r.item.path, ids: {}, guilty: [] });
      }
      const entry = byItem.get(r.itemId)!;
      entry.ids[r.provider] = r.externalId;
      // `guilty` names the ids that actually collide, which `ids` deliberately no
      // longer distinguishes — the reported contamination count needs the guilty
      // ones only, or an item's clean id would inflate it.
      if (bad.has(`${r.provider}|${r.externalId}`)) entry.guilty.push(r.provider);
    }
    return [...byItem.values()];
  }

  /**
   * What the repair would do. Read-only — no writes, no file access.
   *
   * Provider answers are memoised per folder: several items can sit under one
   * folder, and a contaminated id spans several folders, so the naive version
   * asks the same question repeatedly against a rate-limited API.
   */
  async preview(): Promise<RepairPlan> {
    const items = await this.contaminated();
    const seen = new Map<string, FolderIdentity>();
    const proposals: RepairProposal[] = [];

    for (const it of items) {
      const folder = this.folderOf(it.path);
      const { title, year } = this.parseFolder(folder);

      let identity = seen.get(folder);
      if (identity === undefined) {
        identity = await this.resolve(title, year);
        seen.set(folder, identity);
      }

      /*
       * The provider's answer is a property of the FOLDER, so it is memoised. The
       * decision below is a property of the ITEM, because it weighs that item's
       * stored id — two items under one folder can hold different ids, and
       * memoising the verdict instead would silently apply the first one's.
       */
      /*
       * Matched on ANY provider the two have in common, never on `tmdb` by
       * assumption: the tied set comes back in whichever id space answered, so
       * comparing a fixed provider would quietly compare a tmdb id against tvdb
       * ones and read every candidate as a mismatch.
       */
      const ambiguousKeep =
        !Object.keys(identity.ids).length &&
        identity.tied.length > 1 &&
        identity.tied.some((cand) =>
          Object.entries(cand).some(([provider, id]) => it.ids[provider] === id),
        );

      const resolved = ambiguousKeep ? it.ids : identity.ids;
      const changed =
        Object.keys(resolved).length !== Object.keys(it.ids).length ||
        Object.entries(resolved).some(([p, v]) => it.ids[p] !== v);

      proposals.push({
        itemId: it.itemId,
        path: it.path,
        folderTitle: title,
        folderYear: year,
        current: it.ids,
        proposed: resolved,
        ambiguous: identity.tied.length > 1,
        action: !changed ? 'unchanged' : Object.keys(resolved).length ? 'reidentify' : 'clear',
        reason: ambiguousKeep
          ? `${identity.tied.length} films share this title and year; the stored id is one of them — kept`
          : !changed
            ? 'already correct'
            : Object.keys(resolved).length
              ? `verified as "${title}"${year ? ` (${year})` : ''}`
              : identity.tied.length > 1
                ? `${identity.tied.length} films share this title and year and none is the stored id — cleared`
                : 'no verified match — a wrong id is worse than none',
      });
    }

    const contaminatedIds = new Set(
      items.flatMap((i) => i.guilty.map((p) => `${p}|${i.ids[p]}`)),
    ).size;
    return { contaminatedIds, proposals };
  }

  /**
   * Ask the provider chain, through the verification gate, for a folder's identity.
   *
   * When nothing verifies, ask the SECOND question before giving up: was that a
   * blank or a tie? A tie is not the absence of an answer, it is several — and a
   * caller holding one of those candidates already has the evidence needed to
   * choose. Only asked when the first question came back empty, so an unambiguous
   * folder still costs exactly one lookup.
   */
  private async resolve(title: string, year: number | null): Promise<FolderIdentity> {
    const query = { kind: 'movie' as const, title, year };
    try {
      const chain = await this.providers.chain('movie');
      for (const provider of chain) {
        const details = await provider.fetchDetails(query);
        // `fetchDetails` returns null when nothing clears the title+year gate —
        // that null is the whole point, so it must not be papered over.
        if (details?.externalIds && Object.keys(details.externalIds).length) {
          return { ids: details.externalIds, tied: [] };
        }
      }
      for (const provider of chain) {
        const tied = (await provider.ambiguousMovieIds?.(query)) ?? [];
        if (tied.length > 1) return { ids: {}, tied };
      }
    } catch (err) {
      this.logger.warn(`Re-identify failed for "${title}": ${(err as Error).message}`);
    }
    return { ids: {}, tied: [] };
  }

  /**
   * Apply the repair.
   *
   * Re-previews rather than trusting a plan handed in by a caller: the library
   * can change between preview and apply, and an id written from a stale plan is
   * exactly the class of error this service exists to undo.
   */
  async apply(): Promise<{ reidentified: number; cleared: number; unchanged: number }> {
    const { proposals } = await this.preview();
    let reidentified = 0;
    let cleared = 0;
    let unchanged = 0;

    for (const p of proposals) {
      if (p.action === 'unchanged') {
        unchanged += 1;
        continue;
      }
      // Replace wholesale: the wrong rows must go even when nothing replaces them.
      await this.prisma.mediaExternalId.deleteMany({ where: { itemId: p.itemId } });
      for (const [provider, externalId] of Object.entries(p.proposed)) {
        await this.prisma.mediaExternalId.create({
          data: { itemId: p.itemId, provider, externalId },
        });
      }
      if (p.action === 'clear') {
        cleared += 1;
        this.logger.warn(
          `Cleared unverifiable ids from "${p.path}" (folder says "${p.folderTitle}"); `
            + `it held ${JSON.stringify(p.current)}.`,
        );
      } else {
        reidentified += 1;
      }
    }
    return { reidentified, cleared, unchanged };
  }
}
