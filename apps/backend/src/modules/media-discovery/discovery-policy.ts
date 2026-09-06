import type { CategoryMatchMode, DiscoveryDecision, ReleaseType } from '@ultratorrent/shared';

/**
 * Deciding what a discovered title should become.
 *
 * Four outcomes, and the difference between two of them is the point:
 *
 *  - `auto_monitor` — create a watchlist entry and a rule.
 *  - `notify`       — tell someone; this might be wanted.
 *  - `ignore`       — this is not what the template is looking for.
 *  - `needs_review` — **we would have acted and could not safely**. An
 *    unresolved identity, or an auto-add budget already spent. Never confuse it
 *    with `notify`: one says "you might want this", the other says "we nearly
 *    did something and stopped", and an operator triages them differently.
 *
 * Everything here is pure. It reads a title and a template and returns a verdict
 * with the reasoning that produced it — no database, no clock beyond the `now`
 * it is handed, no side effects. That is what makes the decision explainable and
 * the preview honest: Preview Mode runs exactly this and simply does not act on
 * the answer.
 */

export interface TraceStep {
  /** Machine-readable gate name, e.g. `category_policy`. */
  step: string;
  status: 'pass' | 'fail' | 'info';
  /** One sentence a person can read. */
  detail: string;
}

export interface PolicyVerdict {
  /**
   * False when the template does not cover this title at all — wrong media type,
   * or outside its release window. Distinct from `ignore`: a TV template has no
   * opinion about a film, and recording one would be noise.
   */
  applies: boolean;
  decision: DiscoveryDecision;
  reason: string;
  trace: TraceStep[];
}

/** The parts of a discovered title the policy judges. */
export interface PolicyMedia {
  mediaType: string;
  title: string;
  genres: string[];
  originalLanguage?: string | null;
  countries?: string[];
  network?: string | null;
  streamingService?: string | null;
  studio?: string | null;
  popularity?: number | null;
  rating?: number | null;
  voteCount?: number | null;
  identityStatus: string;
  confidence: number;
  releaseDates: Array<{ releaseType: string; date: string | null; region?: string | null }>;
}

/** The parts of a template the policy reads. */
export interface PolicyTemplate {
  mediaType: string;
  upcomingWindowDays: number;
  regions: string[];
  languages: string[];
  minimumPopularity?: number | null;
  minimumRating?: number | null;
  minimumVoteCount?: number | null;
  networks: string[];
  streamingServices: string[];
  studios: string[];
  releaseTypes: string[];
  autoMonitorCategories: string[];
  notifyOnlyCategories: string[];
  ignoreCategories: string[];
  blockedFromAutoCategories: string[];
  categoryMatchMode: string;
  minimumConfidence: number;
}

export interface PolicyContext {
  /** Evaluation time, injected so a verdict is reproducible in a test. */
  now: Date;
  /**
   * True when this template has already spent its daily or weekly automatic-add
   * allowance. An over-budget title is held for review, never dropped — the
   * limit exists to pace acquisition, not to lose titles.
   */
  autoAddBudgetExhausted?: boolean;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Does a title's category list satisfy a policy list, under a match mode?
 *
 * A title with NO categories never matches, under any mode. `ALL` is the mode
 * where that needs saying: "every category qualifies" is vacuously true of an
 * empty list, and a vacuous truth here would auto-monitor every untagged daily
 * news programme in the TVmaze schedule.
 */
export function categoriesMatch(
  categories: string[],
  list: string[],
  mode: CategoryMatchMode | string,
): boolean {
  if (!categories.length || !list.length) return false;
  const want = new Set(list.map(norm));
  const have = categories.map(norm);
  switch (mode) {
    case 'ALL':
      return have.every((c) => want.has(c));
    case 'PRIMARY':
      return want.has(have[0]);
    case 'ANY':
    default:
      return have.some((c) => want.has(c));
  }
}

/** Every category of the title that appears in `list`, for the trace. */
function overlap(categories: string[], list: string[]): string[] {
  const want = new Set(list.map(norm));
  return categories.filter((c) => want.has(norm(c)));
}

export function evaluateDiscovery(
  media: PolicyMedia,
  template: PolicyTemplate,
  ctx: PolicyContext,
): PolicyVerdict {
  const trace: TraceStep[] = [];
  const add = (step: string, status: TraceStep['status'], detail: string) =>
    trace.push({ step, status, detail });

  const notApplicable = (reason: string): PolicyVerdict => ({
    applies: false,
    decision: 'ignore',
    reason,
    trace,
  });
  const verdict = (decision: DiscoveryDecision, reason: string): PolicyVerdict => {
    add('decision', 'info', reason);
    return { applies: true, decision, reason, trace };
  };

  // --- scope ---------------------------------------------------------------
  if (template.mediaType !== 'any' && template.mediaType !== media.mediaType) {
    add('media_type', 'fail', `Template covers ${template.mediaType}, this is ${media.mediaType}`);
    return notApplicable('Template does not cover this media type');
  }
  add('media_type', 'pass', `Media type ${media.mediaType} is covered`);

  const dated = qualifyingRelease(media, template, ctx.now);
  if (!dated.ok) {
    add('release_window', 'fail', dated.detail);
    return notApplicable(dated.detail);
  }
  add('release_window', 'pass', dated.detail);

  // --- locale --------------------------------------------------------------
  if (template.languages.length) {
    const lang = media.originalLanguage ? norm(media.originalLanguage) : null;
    const want = template.languages.map(norm);
    if (!lang || !want.includes(lang)) {
      add('language', 'fail', `Language ${media.originalLanguage ?? 'unknown'} is not in the template's list`);
      return notApplicable('Language not allowed');
    }
    add('language', 'pass', `Language ${media.originalLanguage} is allowed`);
  }

  if (template.regions.length && media.countries?.length) {
    const want = new Set(template.regions.map((r) => r.toUpperCase()));
    const hit = media.countries.find((c) => want.has(c.toUpperCase()));
    if (!hit) {
      add('region', 'fail', `Countries ${media.countries.join(', ')} are not in the template's regions`);
      return notApplicable('Region not allowed');
    }
    add('region', 'pass', `Region ${hit} is allowed`);
  }

  const source = sourceFilter(media, template);
  if (!source.ok) {
    add('source', 'fail', source.detail);
    return notApplicable(source.detail);
  }
  if (source.detail) add('source', 'pass', source.detail);

  // --- category policy -----------------------------------------------------
  const mode = template.categoryMatchMode as CategoryMatchMode;
  if (!media.genres.length) {
    add('category_policy', 'info', 'This title carries no categories, so none can qualify it');
  }

  /*
   * Exclusion is evaluated FIRST and beats everything.
   *
   * A Sci-Fi + Documentary title does not auto-monitor when Documentary is
   * blocked, however well Sci-Fi qualifies. Blocking is deliberately checked with
   * ANY regardless of the template's mode: a blocking list means "if this appears
   * at all", and reading it under ALL would make a block that almost never fires.
   */
  const blocked = overlap(media.genres, template.blockedFromAutoCategories);
  if (blocked.length) {
    add('blocked_category', 'fail', `Blocked from automatic monitoring by: ${blocked.join(', ')}`);
  }

  if (categoriesMatch(media.genres, template.ignoreCategories, mode)) {
    add('category_policy', 'fail', `Ignored: ${overlap(media.genres, template.ignoreCategories).join(', ')}`);
    return verdict('ignore', `Category ${overlap(media.genres, template.ignoreCategories).join(', ')} is set to ignore`);
  }

  const wantsAuto = categoriesMatch(media.genres, template.autoMonitorCategories, mode);
  const wantsNotify = categoriesMatch(media.genres, template.notifyOnlyCategories, mode);

  if (!wantsAuto && !wantsNotify) {
    /*
     * Nothing the template named matched. Ignoring rather than notifying is what
     * keeps the inbox meaningful: a template says what it is looking for, and
     * surfacing everything it did not ask about would bury the titles it did.
     */
    add('category_policy', 'fail', 'No configured category matched');
    return verdict('ignore', 'No configured category matched this title');
  }

  if (wantsAuto) {
    add('category_policy', 'pass', `Auto-monitor category matched: ${overlap(media.genres, template.autoMonitorCategories).join(', ')}`);
  } else {
    add('category_policy', 'pass', `Notify-only category matched: ${overlap(media.genres, template.notifyOnlyCategories).join(', ')}`);
  }

  // Everything below can only DEMOTE an auto-monitor candidate.
  if (!wantsAuto) return verdict('notify', 'Category is configured as notify-only');
  if (blocked.length) {
    return verdict('notify', `Qualified, but blocked from automatic monitoring by ${blocked.join(', ')}`);
  }

  // --- thresholds ----------------------------------------------------------
  const below = thresholds(media, template);
  if (below) {
    add('threshold', 'fail', below);
    // Demoted, not dropped: it is the right kind of title, below the bar the
    // operator set for acting without being asked.
    return verdict('notify', below);
  }
  add('threshold', 'pass', 'Meets the popularity, rating and vote thresholds');

  /*
   * --- identity -----------------------------------------------------------
   *
   * The last gate before acting, and the one that must not be configurable
   * around. An unresolved identity is held for REVIEW rather than notified:
   * everything else about this title qualified, so the only thing standing
   * between it and a watchlist entry is a question a person can answer.
   */
  if (media.identityStatus !== 'resolved') {
    add('identity', 'fail', `Identity is ${media.identityStatus}`);
    return verdict('needs_review', `Identity is ${media.identityStatus} — two works may share this title`);
  }
  if (media.confidence < template.minimumConfidence) {
    add('identity', 'fail', `Confidence ${media.confidence} is below the required ${template.minimumConfidence}`);
    return verdict(
      'needs_review',
      `Identity confidence ${media.confidence} is below the required ${template.minimumConfidence}`,
    );
  }
  add('identity', 'pass', `Identity resolved with confidence ${media.confidence}`);

  /*
   * --- budget -------------------------------------------------------------
   *
   * Held, never discarded. The limit paces acquisition; losing the title would
   * be a different feature, and a worse one.
   */
  if (ctx.autoAddBudgetExhausted) {
    add('auto_add_limit', 'fail', 'Automatic-add threshold reached');
    return verdict('needs_review', 'Automatic-add threshold reached');
  }
  add('auto_add_limit', 'pass', 'Within the automatic-add limits');

  return verdict('auto_monitor', 'Qualified on category, thresholds and identity');
}

/** Does the title have a release of a wanted type inside the window? */
function qualifyingRelease(
  media: PolicyMedia,
  template: PolicyTemplate,
  now: Date,
): { ok: boolean; detail: string } {
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + template.upcomingWindowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const wanted = new Set(template.releaseTypes.map((t) => t as ReleaseType));
  const candidates = media.releaseDates.filter((d) => d.date !== null);
  if (!candidates.length) {
    /*
     * A title whose date nobody knows is still a discovery. It cannot satisfy a
     * window, so it falls out of a windowed template — but it is reported as
     * undated rather than as "outside the window", which would claim knowledge we
     * do not have.
     */
    return { ok: false, detail: 'No provider has given this title a release date' };
  }

  const hit = candidates.find(
    (d) =>
      (wanted.size === 0 || wanted.has(d.releaseType as ReleaseType)) &&
      d.date! >= from &&
      d.date! <= to &&
      (template.regions.length === 0 || !d.region || template.regions.some((r) => r.toUpperCase() === d.region!.toUpperCase())),
  );

  return hit
    ? { ok: true, detail: `Releases ${hit.date} (${hit.releaseType}${hit.region ? `, ${hit.region}` : ''})` }
    : {
        ok: false,
        detail: wanted.size
          ? `No ${[...wanted].join('/')} release between ${from} and ${to}`
          : `No release between ${from} and ${to}`,
      };
}

/** Network / streaming service / studio filters, when the template names any. */
function sourceFilter(media: PolicyMedia, template: PolicyTemplate): { ok: boolean; detail: string } {
  const checks: Array<[string, string | null | undefined, string[]]> = [
    ['network', media.network, template.networks],
    ['streaming service', media.streamingService, template.streamingServices],
    ['studio', media.studio, template.studios],
  ];
  const active = checks.filter(([, , list]) => list.length);
  if (!active.length) return { ok: true, detail: '' };

  /*
   * These read as alternatives, not requirements. A template naming both networks
   * and streaming services wants "on any of these", and a title carries at most
   * one or two of the three fields — requiring all of them would match nothing.
   */
  for (const [label, value, list] of active) {
    if (value && list.some((x) => norm(x) === norm(value))) {
      return { ok: true, detail: `${label} ${value} is allowed` };
    }
  }
  return {
    ok: false,
    detail: `Not carried by any allowed ${active.map(([label]) => label).join(' / ')}`,
  };
}

/** The first threshold this title falls below, or null. */
function thresholds(media: PolicyMedia, template: PolicyTemplate): string | null {
  if (template.minimumPopularity != null) {
    if (media.popularity == null) return `Popularity is unknown, and ${template.minimumPopularity} is required`;
    if (media.popularity < template.minimumPopularity) {
      return `Popularity ${media.popularity} is below the required ${template.minimumPopularity}`;
    }
  }
  if (template.minimumRating != null) {
    if (media.rating == null) return `Rating is unknown, and ${template.minimumRating} is required`;
    if (media.rating < template.minimumRating) {
      return `Rating ${media.rating} is below the required ${template.minimumRating}`;
    }
  }
  if (template.minimumVoteCount != null) {
    if (media.voteCount == null) return `Vote count is unknown, and ${template.minimumVoteCount} is required`;
    if (media.voteCount < template.minimumVoteCount) {
      return `Vote count ${media.voteCount} is below the required ${template.minimumVoteCount}`;
    }
  }
  return null;
}
