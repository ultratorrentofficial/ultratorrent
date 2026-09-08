import { languageAllowed } from '@ultratorrent/shared';
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
  releaseDates: Array<{ releaseType: string; date: string | null; region?: string | null; source?: string | null }>;
  /**
   * When the SERIES first aired — not when the next episode does.
   *
   * The absence of this was the whole defect: the policy only ever saw
   * `releaseDates`, and TVmaze reports `episode_air` and `season_premiere` for
   * shows that started years ago, so a 2022 series airing this week looked
   * exactly like a new one.
   */
  premiereDate?: string | null;
  /** continuing | returning | planned | in_production | ended | canceled | unknown. */
  seriesStatus?: string | null;
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
  /** When false, a qualifying title is held for a person instead of monitored. */
  autoMonitorEnabled?: boolean;
  requireUpcoming?: boolean;
  gracePeriodDays?: number;
  /** review | ignore */
  pastReleaseBehavior?: string;
  /** existing_only | review */
  returningSeriesBehavior?: string;
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
    /*
     * Compared canonically, because providers disagree about what a language is
     * called: TMDB stores `en`, TVmaze stores `English`, and both land in the
     * same catalogue. Comparing raw meant a template saying "English" rejected
     * every TMDB-sourced title — 170 of 596 rows on a live catalogue — and the
     * inbox showed them as though nothing had ever looked at them.
     */
    if (!languageAllowed(media.originalLanguage, template.languages)) {
      add(
        'language',
        'fail',
        `Language ${media.originalLanguage ?? 'unknown'} is not in the template's list (${template.languages.join(', ')})`,
      );
      return notApplicable(
        `Language ${media.originalLanguage ?? 'unknown'} is not one this template accepts`,
      );
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

  /*
   * Automation switched off: the title still QUALIFIES, it just waits.
   *
   * Checked before the remaining gates so the reason a person reads is the one
   * that actually applies — being told a title needs review because automation
   * is off is actionable, being told it failed a threshold it never reached is
   * not.
   */
  if (template.autoMonitorEnabled === false) {
    add('auto_monitor_switch', 'fail', 'Automatic monitoring is switched off for this template');
    return verdict(
      'needs_review',
      'Qualified, but this template does not monitor automatically — import it to proceed',
    );
  }

  /*
   * --- NEW / UPCOMING ELIGIBILITY -----------------------------------------
   *
   * A hard gate, not a preference: no category, threshold or score can carry a
   * title past it. "A Sci-Fi title that premiered two years ago must not become
   * auto-monitored just because Sci-Fi is an Auto category."
   *
   * It sits here, after the category match rather than before it, on purpose.
   * Run earlier it would surface every past-premiere show on the provider's
   * schedule for review — including all the ones the template never asked about
   * — and burying the titles a template DID ask for is the failure this inbox is
   * designed to avoid. What matters is that it is unreachable-past for an
   * auto-monitor, and it is: this is the only route to that decision.
   *
   * Series only. A film's "premiere" is one of several typed release dates, and
   * "monitor films once they reach streaming" is a legitimate, documented
   * configuration whose digital date is often a year after the theatrical one —
   * gating movies on a past premiere would break it. For films the release-type
   * and window rules already say what "upcoming" means.
   */
  if (media.mediaType !== 'movie' && (template.requireUpcoming ?? true)) {
    const eligibility = premiereEligibility(media, template, ctx.now);
    if (eligibility.outcome !== 'upcoming') {
      add('upcoming_eligibility', 'fail', eligibility.detail);
      if (eligibility.outcome === 'past') {
        return (template.pastReleaseBehavior ?? 'review') === 'ignore'
          ? verdict('ignore', eligibility.detail)
          : verdict('review_past_release', eligibility.detail);
      }
      // Unknown or contradicted: a person decides, and the evidence is kept.
      return verdict('needs_review', eligibility.detail);
    }
    add('upcoming_eligibility', 'pass', eligibility.detail);
  }
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

/**
 * Has this series premiered yet?
 *
 * Four answers, and three of them refuse to automate:
 *
 *   upcoming  — premiere is today or later (or inside the grace period)
 *   past      — it already started; importing it is a person's decision
 *   unknown   — nobody gave it a premiere date; we will not guess
 *   conflict  — providers materially disagree; we will not pick a winner
 *
 * `unknown` and `conflict` are deliberately not "assume it is fine". This gate
 * exists to stop old series being imported automatically, and an unknown date is
 * exactly the case where that would happen silently.
 */
function premiereEligibility(
  media: PolicyMedia,
  template: PolicyTemplate,
  now: Date,
): { outcome: 'upcoming' | 'past' | 'unknown' | 'conflict'; detail: string } {
  const grace = Math.max(0, template.gracePeriodDays ?? 0);
  const cutoff = new Date(now.getTime() - grace * 86_400_000).toISOString().slice(0, 10);

  /*
   * Every distinct series-premiere date any provider reported.
   *
   * `source` is the provider, so two different dates here is a genuine
   * disagreement rather than one provider being imprecise about regions.
   */
  const reported = media.releaseDates.filter((d) => d.releaseType === 'series_premiere' && d.date);
  const distinct = [...new Set(reported.map((d) => d.date!.slice(0, 10)))];
  if (distinct.length > 1) {
    return {
      outcome: 'conflict',
      detail: `Providers disagree about the premiere date (${distinct.sort().join(', ')}) — not automating on a date nobody agrees on`,
    };
  }

  const premiere = media.premiereDate?.slice(0, 10) ?? distinct[0] ?? null;
  if (!premiere) {
    return {
      outcome: 'unknown',
      detail: 'No provider has given this series a premiere date',
    };
  }

  if (premiere >= cutoff) {
    return {
      outcome: 'upcoming',
      detail: grace
        ? `Premieres ${premiere}, within the ${grace}-day grace period`
        : `Premieres ${premiere}`,
    };
  }

  /*
   * A returning series is named as such, because "premiered in 2022" and "has a
   * new season coming" are both true and the operator needs to know which one
   * they are looking at.
   */
  const returning = media.seriesStatus === 'returning' || media.seriesStatus === 'continuing';
  return {
    outcome: 'past',
    detail: returning
      ? `This series premiered ${premiere} and is not monitored here — a returning series is not imported automatically`
      : `Series premiered ${premiere}, before the automatic-monitoring eligibility window`,
  };
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

/**
 * A value is only a number if it really is one.
 *
 * `null` was the only "unknown" this checked for, so a provider returning the
 * STRING `"Infinity"` sailed through: `'Infinity' < 50` is false, the comparison
 * reported no failure, and a title with unverifiable popularity was auto-monitored
 * past a floor set precisely to hold it back. NaN behaves the same way — every
 * comparison against it is false, so an unguarded `<` reads a broken value as a
 * passing one.
 */
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The first threshold this title falls below, or null. */
function thresholds(media: PolicyMedia, template: PolicyTemplate): string | null {
  const checks: Array<[label: string, value: unknown, floor: number | null | undefined]> = [
    ['Popularity', media.popularity, template.minimumPopularity],
    ['Rating', media.rating, template.minimumRating],
    ['Vote count', media.voteCount, template.minimumVoteCount],
  ];
  for (const [label, raw, floor] of checks) {
    if (floor == null) continue;
    const value = numeric(raw);
    if (value === null) return `${label} is unknown, and ${floor} is required`;
    if (value < floor) return `${label} ${value} is below the required ${floor}`;
  }
  return null;
}
