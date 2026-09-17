import {
  categoriesMatch,
  evaluateDiscovery,
  type PolicyMedia,
  type PolicyTemplate,
} from './discovery-policy';

const NOW = new Date('2026-09-05T00:00:00Z');
const soon = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);

const media = (over: Partial<PolicyMedia> = {}): PolicyMedia => ({
  mediaType: 'tv',
  title: 'Example Series',
  genres: ['Sci-Fi'],
  identityStatus: 'resolved',
  confidence: 1,
  releaseDates: [{ releaseType: 'series_premiere', date: soon(10), region: 'US' }],
  ...over,
});

const template = (over: Partial<PolicyTemplate> = {}): PolicyTemplate => ({
  mediaType: 'any',
  upcomingWindowDays: 90,
  regions: [],
  languages: [],
  networks: [],
  streamingServices: [],
  studios: [],
  releaseTypes: [],
  autoMonitorCategories: ['Sci-Fi'],
  notifyOnlyCategories: ['Drama'],
  ignoreCategories: ['Reality'],
  blockedFromAutoCategories: [],
  categoryMatchMode: 'ANY',
  minimumConfidence: 0.8,
  ...over,
});

const run = (m: Partial<PolicyMedia> = {}, t: Partial<PolicyTemplate> = {}, budget = false) =>
  evaluateDiscovery(media(m), template(t), { now: NOW, autoAddBudgetExhausted: budget });

describe('categoriesMatch', () => {
  it('ANY needs one qualifying category', () => {
    expect(categoriesMatch(['Sci-Fi', 'Drama'], ['Sci-Fi'], 'ANY')).toBe(true);
    expect(categoriesMatch(['Drama'], ['Sci-Fi'], 'ANY')).toBe(false);
  });

  it('ALL needs every category the title carries to qualify', () => {
    expect(categoriesMatch(['Sci-Fi', 'Action'], ['Sci-Fi', 'Action', 'Crime'], 'ALL')).toBe(true);
    expect(categoriesMatch(['Sci-Fi', 'Comedy'], ['Sci-Fi', 'Action'], 'ALL')).toBe(false);
  });

  it('PRIMARY looks only at the first category', () => {
    expect(categoriesMatch(['Sci-Fi', 'Comedy'], ['Sci-Fi'], 'PRIMARY')).toBe(true);
    expect(categoriesMatch(['Comedy', 'Sci-Fi'], ['Sci-Fi'], 'PRIMARY')).toBe(false);
  });

  it('is case- and space-insensitive', () => {
    expect(categoriesMatch([' sci-fi '], ['Sci-Fi'], 'ANY')).toBe(true);
  });

  /*
   * TMDB's TELEVISION taxonomy ships compound buckets — `Action & Adventure`,
   * `Sci-Fi & Fantasy`, `War & Politics` — while its movie taxonomy and every
   * hand-written template use the split names. Measured on a live install: a
   * template listing Action, Adventure, Sci-Fi and Fantasy matched none of
   * them, and the titles were filed as carrying no configured category.
   */
  it('matches a compound provider category against a split template entry', () => {
    expect(categoriesMatch(['Action & Adventure'], ['Action'], 'ANY')).toBe(true);
    expect(categoriesMatch(['Sci-Fi & Fantasy'], ['Fantasy'], 'ANY')).toBe(true);
  });

  it('matches a split provider category against a compound template entry', () => {
    expect(categoriesMatch(['Action'], ['Action & Adventure'], 'ANY')).toBe(true);
  });

  it('still matches a compound written out in full on both sides', () => {
    expect(categoriesMatch(['Action & Adventure'], ['Action & Adventure'], 'ANY')).toBe(true);
  });

  /* The live case: Mystery was configured; the compound is what failed ALL. */
  it('lets a compound satisfy ALL when one of its parts is configured', () => {
    expect(
      categoriesMatch(['Mystery', 'Action & Adventure'], ['Mystery', 'Action', 'Adventure'], 'ALL'),
    ).toBe(true);
  });

  /*
   * One part is enough, deliberately. No provider emits `Politics` alone, so
   * the stricter reading would leave that bucket unreachable by any template.
   */
  it('qualifies on one part even when the other is unlisted', () => {
    expect(categoriesMatch(['War & Politics'], ['War'], 'ANY')).toBe(true);
  });

  it('does not match when no part is configured', () => {
    expect(categoriesMatch(['Sci-Fi & Fantasy'], ['Crime'], 'ANY')).toBe(false);
  });

  /* Splitting must not weaken exclusion — it should make it fire more often. */
  it('ignores a compound when one of its parts is on the ignore list', () => {
    const v = run(
      { genres: ['Animation & Comedy'] },
      {
        autoMonitorCategories: ['Animation'],
        ignoreCategories: ['Comedy'],
        categoryMatchMode: 'ANY',
      },
    );
    expect(v.decision).toBe('ignore');
  });

  it('does not auto-monitor a compound whose part is blocked', () => {
    const v = run(
      { genres: ['Sci-Fi & Fantasy'] },
      {
        autoMonitorCategories: ['Sci-Fi'],
        blockedFromAutoCategories: ['Fantasy'],
        categoryMatchMode: 'ANY',
      },
    );
    expect(v.decision).not.toBe('auto_monitor');
  });

  /*
   * "Every category qualifies" is vacuously TRUE of an empty list. A vacuous
   * truth here would auto-monitor every untagged daily news programme in the
   * TVmaze schedule — and most of that schedule is untagged.
   */
  it('never matches a title with no categories, including under ALL', () => {
    expect(categoriesMatch([], ['Sci-Fi'], 'ANY')).toBe(false);
    expect(categoriesMatch([], ['Sci-Fi'], 'ALL')).toBe(false);
    expect(categoriesMatch([], ['Sci-Fi'], 'PRIMARY')).toBe(false);
  });
});

/**
 * What ALL says when it rejects a title.
 *
 * "No configured category matched this title" was emitted whenever the mode's
 * test failed, including when categories HAD matched and a single unlisted one
 * sank the rest. On one live install that sentence was wrong for 6 of 122
 * ignored titles, and it named nothing anybody could act on.
 */
describe('why ALL rejected a title', () => {
  it('names the unlisted category instead of claiming nothing matched', () => {
    const v = run(
      { genres: ['Mystery', 'Cooking'] },
      {
        autoMonitorCategories: ['Mystery'],
        notifyOnlyCategories: [],
        categoryMatchMode: 'ALL',
      },
    );
    expect(v.decision).toBe('ignore');
    expect(v.reason).toMatch(/Cooking/);
    expect(v.reason).not.toMatch(/No configured category matched/);
  });

  /* When nothing matched, the original sentence is true and stays. */
  it('still says nothing matched when nothing did', () => {
    const v = run(
      { genres: ['Cooking'] },
      {
        autoMonitorCategories: ['Mystery'],
        notifyOnlyCategories: [],
        categoryMatchMode: 'ALL',
      },
    );
    expect(v.reason).toBe('No configured category matched this title');
  });
});

describe('scope — when a template has no opinion at all', () => {
  /*
   * `applies: false` is distinct from `ignore`. A TV template has no opinion
   * about a film, and recording one would be noise in the Ignored view.
   */
  it('does not apply to the wrong media type', () => {
    const v = run({ mediaType: 'movie' }, { mediaType: 'tv' });
    expect(v.applies).toBe(false);
  });

  it('does not apply outside the release window', () => {
    const v = run({ releaseDates: [{ releaseType: 'series_premiere', date: soon(200) }] }, { upcomingWindowDays: 90 });
    expect(v.applies).toBe(false);
    expect(v.reason).toMatch(/No release between/);
  });

  /*
   * "Undated" and "outside the window" are different facts. Saying the second
   * when we mean the first claims knowledge we do not have.
   */
  it('reports an undated title as undated, not as out of window', () => {
    const v = run({ releaseDates: [{ releaseType: 'series_premiere', date: null }] });
    expect(v.applies).toBe(false);
    expect(v.reason).toMatch(/no provider has given this title a release date/i);
  });

  it('respects the template’s release types', () => {
    const v = run(
      { releaseDates: [{ releaseType: 'wide_theatrical', date: soon(10) }] },
      { releaseTypes: ['digital', 'streaming'] },
    );
    expect(v.applies).toBe(false);
    expect(v.reason).toMatch(/digital\/streaming/);
  });
});

describe('the three outcomes', () => {
  it('auto-monitors a qualifying title', () => {
    const v = run();
    expect(v.decision).toBe('auto_monitor');
    expect(v.trace.map((s) => s.step)).toEqual(
      expect.arrayContaining(['media_type', 'release_window', 'category_policy', 'threshold', 'identity', 'auto_add_limit']),
    );
  });

  it('notifies for a notify-only category', () => {
    const v = run({ genres: ['Drama'] });
    expect(v.decision).toBe('notify');
  });

  it('ignores an ignored category', () => {
    const v = run({ genres: ['Reality'] });
    expect(v.decision).toBe('ignore');
    expect(v.reason).toMatch(/Reality/);
  });

  /*
   * A template says what it is looking for. Surfacing everything it did not ask
   * about would bury the titles it did.
   */
  it('ignores a title no configured category matched', () => {
    const v = run({ genres: ['Western'] });
    expect(v.decision).toBe('ignore');
    expect(v.reason).toMatch(/No configured category matched/);
  });

  it('ignores an untagged title rather than auto-monitoring it', () => {
    const v = run({ genres: [] });
    expect(v.decision).toBe('ignore');
  });
});

describe('exclusion precedence', () => {
  /*
   * The brief's example: Sci-Fi + Documentary must not auto-create a rule when
   * Documentary is blocking, however well Sci-Fi qualifies.
   */
  it('demotes an otherwise-qualifying title blocked by a second category', () => {
    const v = run(
      { genres: ['Sci-Fi', 'Documentary'] },
      { blockedFromAutoCategories: ['Documentary'] },
    );
    expect(v.decision).toBe('notify');
    expect(v.reason).toMatch(/blocked from automatic monitoring by Documentary/i);
  });

  it('leaves the title reachable by hand — blocked means not automatic, not gone', () => {
    const v = run({ genres: ['Sci-Fi', 'Documentary'] }, { blockedFromAutoCategories: ['Documentary'] });
    expect(v.decision).not.toBe('ignore');
  });

  /*
   * A blocking list means "if this appears at all". Reading it under ALL would
   * make a block that almost never fires.
   */
  it('applies blocking with ANY semantics even when the template mode is ALL', () => {
    const v = run(
      { genres: ['Sci-Fi', 'Documentary'] },
      {
        categoryMatchMode: 'ALL',
        autoMonitorCategories: ['Sci-Fi', 'Documentary'],
        blockedFromAutoCategories: ['Documentary'],
      },
    );
    expect(v.decision).toBe('notify');
  });

  it('ignore still beats a matching auto-monitor category', () => {
    const v = run({ genres: ['Sci-Fi', 'Reality'] });
    expect(v.decision).toBe('ignore');
  });
});

describe('thresholds demote rather than drop', () => {
  it('notifies a qualifying title below the popularity floor', () => {
    const v = run({ popularity: 12 }, { minimumPopularity: 50 });
    expect(v.decision).toBe('notify');
    expect(v.reason).toMatch(/Popularity 12 is below the required 50/);
  });

  /*
   * A threshold the provider cannot answer is not a pass. Treating unknown as
   * satisfied would let every title with missing metadata through the one gate
   * the operator set to hold things back.
   */
  it('treats an unknown value as failing the threshold, not passing it', () => {
    const v = run({ popularity: null }, { minimumPopularity: 50 });
    expect(v.decision).toBe('notify');
    expect(v.reason).toMatch(/Popularity is unknown/);
  });

  it('checks rating and vote count too', () => {
    expect(run({ rating: 4 }, { minimumRating: 7 }).reason).toMatch(/Rating 4/);
    expect(run({ voteCount: 5 }, { minimumVoteCount: 100 }).reason).toMatch(/Vote count 5/);
  });
});

describe('the identity gate', () => {
  /*
   * needs_review, not notify. Everything else about this title qualified, so the
   * only thing between it and a watchlist entry is a question a person can
   * answer — and an operator triages that differently from a suggestion.
   */
  it('holds an ambiguous identity for review', () => {
    const v = run({ identityStatus: 'ambiguous', confidence: 0.2 });
    expect(v.decision).toBe('needs_review');
    expect(v.reason).toMatch(/ambiguous/);
  });

  it('holds a conflicted identity for review', () => {
    expect(run({ identityStatus: 'conflicted', confidence: 0.2 }).decision).toBe('needs_review');
  });

  it('holds a resolved-but-low-confidence identity for review', () => {
    const v = run({ confidence: 0.3 }, { minimumConfidence: 0.8 });
    expect(v.decision).toBe('needs_review');
    expect(v.reason).toMatch(/0\.3 is below the required 0\.8/);
  });

  it('lets a template lower its own confidence floor', () => {
    expect(run({ confidence: 0.3 }, { minimumConfidence: 0.2 }).decision).toBe('auto_monitor');
  });

  /*
   * The floor is configurable; the STATUS is not. A template cannot set its way
   * past two works sharing a title, because that is the failure that writes a
   * wrong id into the library.
   */
  it('cannot be configured past an ambiguous identity', () => {
    const v = run({ identityStatus: 'ambiguous', confidence: 1 }, { minimumConfidence: 0 });
    expect(v.decision).toBe('needs_review');
  });
});

describe('the auto-add budget', () => {
  it('holds an over-budget title for review rather than dropping it', () => {
    const v = run({}, {}, true);
    expect(v.decision).toBe('needs_review');
    expect(v.reason).toMatch(/Automatic-add threshold reached/);
  });

  it('does not consume budget for a title that was only going to be notified', () => {
    const v = run({ genres: ['Drama'] }, {}, true);
    expect(v.decision).toBe('notify');
  });
});

describe('locale and source filters', () => {
  it('excludes a language the template did not name', () => {
    expect(run({ originalLanguage: 'ru' }, { languages: ['en'] }).applies).toBe(false);
  });

  it('excludes a region the template did not name', () => {
    expect(run({ countries: ['RU'] }, { regions: ['US'] }).applies).toBe(false);
  });

  /*
   * A title carries at most one or two of network / streaming service / studio,
   * so requiring all three would match nothing. They read as alternatives.
   */
  it('treats network, streaming service and studio as alternatives', () => {
    const v = run(
      { network: null, streamingService: 'Peacock', studio: null },
      { networks: ['PBS'], streamingServices: ['Peacock'] },
    );
    expect(v.applies).toBe(true);
    expect(v.decision).toBe('auto_monitor');
  });

  it('excludes a title on none of the named sources', () => {
    const v = run({ network: 'ITV1', streamingService: null }, { networks: ['PBS'] });
    expect(v.applies).toBe(false);
  });
});

describe('the trace', () => {
  it('records every gate that ran, in order, with a readable reason', () => {
    const v = run({ genres: ['Sci-Fi'], popularity: 83, originalLanguage: 'en', countries: ['US'] }, {
      minimumPopularity: 50,
      languages: ['en'],
      regions: ['US'],
    });
    const steps = v.trace.map((s) => `${s.step}:${s.status}`);
    expect(steps).toEqual([
      'media_type:pass',
      'release_window:pass',
      'language:pass',
      'region:pass',
      'category_policy:pass',
      // The new/upcoming gate sits after the category match and before every
      // threshold: nothing below it can restore an auto-monitor it refused.
      'upcoming_eligibility:pass',
      'threshold:pass',
      'identity:pass',
      'auto_add_limit:pass',
      'decision:info',
    ]);
    expect(v.trace.every((s) => s.detail.length > 0)).toBe(true);
  });

  it('explains a refusal in the step that caused it', () => {
    const v = run({ genres: ['Sci-Fi', 'Documentary'] }, { blockedFromAutoCategories: ['Documentary'] });
    const blocked = v.trace.find((s) => s.step === 'blocked_category');
    expect(blocked).toMatchObject({ status: 'fail' });
    expect(blocked!.detail).toMatch(/Documentary/);
  });

  it('is pure — the same inputs give the same verdict', () => {
    const a = run({ genres: ['Sci-Fi'] });
    const b = run({ genres: ['Sci-Fi'] });
    expect(a).toEqual(b);
  });
});
