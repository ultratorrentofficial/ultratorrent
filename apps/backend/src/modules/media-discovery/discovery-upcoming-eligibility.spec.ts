import { evaluateDiscovery, type PolicyMedia, type PolicyTemplate } from './discovery-policy';

/**
 * The new/upcoming eligibility gate.
 *
 * A 2022 series airing an episode this week used to be auto-monitored, because
 * the only date test asked whether ANY release date of a wanted type fell in the
 * forward window — and TVmaze reports `episode_air` and `season_premiere` for
 * shows that started years ago. The policy could not see a premiere date at all.
 *
 * `now` is injected everywhere here. A fixture pinned to an absolute date
 * already rotted once in this repository, passing for two days and then failing
 * with nothing having changed.
 */

const NOW = new Date('2026-09-07T12:00:00Z');
const day = (offset: number) =>
  new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

const TEMPLATE: PolicyTemplate = {
  mediaType: 'any',
  upcomingWindowDays: 90,
  regions: [],
  languages: [],
  networks: [],
  streamingServices: [],
  studios: [],
  releaseTypes: [],
  autoMonitorCategories: ['Sci-Fi'],
  notifyOnlyCategories: [],
  ignoreCategories: [],
  blockedFromAutoCategories: [],
  categoryMatchMode: 'ANY',
  minimumConfidence: 0.8,
};

/**
 * A series that qualifies on every axis except its premiere date, and which
 * always has a qualifying date in the window — an episode airing next week, the
 * exact shape that used to sail through.
 */
const series = (over: Partial<PolicyMedia> = {}): PolicyMedia => ({
  mediaType: 'tv',
  title: 'Example Series',
  genres: ['Sci-Fi'],
  identityStatus: 'resolved',
  confidence: 1,
  releaseDates: [{ releaseType: 'episode_air', date: day(7), region: 'US', source: 'tvmaze' }],
  ...over,
});

const decide = (media: PolicyMedia, template: Partial<PolicyTemplate> = {}) =>
  evaluateDiscovery(media, { ...TEMPLATE, ...template }, { now: NOW });

describe('the bug this closes', () => {
  /*
   * The reported behaviour, exactly: an old series with an episode airing this
   * week, in an auto-monitor category.
   */
  it('does not auto-monitor a 2022 series that happens to be airing now', () => {
    const v = decide(series({ premiereDate: '2022-11-13', seriesStatus: 'continuing' }));
    expect(v.decision).not.toBe('auto_monitor');
    expect(v.decision).toBe('review_past_release');
  });

  /*
   * The gate is HARD. It is reached only after the category matched, so a
   * matching category is precisely what cannot rescue it.
   */
  it('is not overridden by an auto-monitor category', () => {
    const v = decide(series({ premiereDate: '2024-05-11', genres: ['Sci-Fi', 'Action'] }));
    expect(v.decision).toBe('review_past_release');
    expect(v.trace.some((t) => t.step === 'category_policy' && t.status === 'pass')).toBe(true);
    expect(v.trace.some((t) => t.step === 'upcoming_eligibility' && t.status === 'fail')).toBe(true);
  });

  it('still surfaces the title rather than dropping it', () => {
    const v = decide(series({ premiereDate: '2024-05-11' }));
    expect(v.applies).toBe(true);
    expect(v.reason).toMatch(/premiered/);
  });
});

describe('the date boundary', () => {
  it('is eligible when the premiere is tomorrow', () => {
    expect(decide(series({ premiereDate: day(1) })).decision).toBe('auto_monitor');
  });

  it('is eligible when the premiere is today', () => {
    expect(decide(series({ premiereDate: day(0) })).decision).toBe('auto_monitor');
  });

  it('is not eligible when the premiere was yesterday and there is no grace', () => {
    expect(decide(series({ premiereDate: day(-1) })).decision).toBe('review_past_release');
  });

  it('is eligible when yesterday falls inside a configured grace period', () => {
    expect(decide(series({ premiereDate: day(-1) }), { gracePeriodDays: 3 }).decision).toBe('auto_monitor');
  });

  it('is not eligible outside the grace period', () => {
    expect(decide(series({ premiereDate: day(-4) }), { gracePeriodDays: 3 }).decision).toBe('review_past_release');
  });

  it('is not eligible a year later', () => {
    expect(decide(series({ premiereDate: day(-365) })).decision).toBe('review_past_release');
  });

  /*
   * A grace period must never appear on its own. An operator who did not ask for
   * one gets today-or-later.
   */
  it('defaults to no grace at all', () => {
    expect(TEMPLATE.gracePeriodDays).toBeUndefined();
    expect(decide(series({ premiereDate: day(-1) })).decision).toBe('review_past_release');
  });
});

describe('when the date cannot be trusted', () => {
  /*
   * Treating unknown as eligible is the exact failure this gate exists to
   * prevent, and it would be silent.
   */
  it('sends an unknown premiere date to review, never to auto-monitor', () => {
    const v = decide(series({ premiereDate: null }));
    expect(v.decision).toBe('needs_review');
    expect(v.reason).toMatch(/No provider has given this series a premiere date/);
  });

  it('sends materially conflicting provider dates to review', () => {
    const v = decide(
      series({
        premiereDate: null,
        releaseDates: [
          { releaseType: 'series_premiere', date: '2026-11-15', region: null, source: 'tmdb' },
          { releaseType: 'series_premiere', date: '2022-07-01', region: null, source: 'tvmaze' },
        ],
      }),
    );
    expect(v.decision).toBe('needs_review');
    expect(v.reason).toMatch(/disagree/);
  });

  it('keeps the conflicting evidence in the reason rather than picking a winner', () => {
    const v = decide(
      series({
        premiereDate: null,
        releaseDates: [
          { releaseType: 'series_premiere', date: '2026-11-15', region: null, source: 'tmdb' },
          { releaseType: 'series_premiere', date: '2022-07-01', region: null, source: 'tvmaze' },
        ],
      }),
    );
    expect(v.reason).toContain('2022-07-01');
    expect(v.reason).toContain('2026-11-15');
  });

  it('does not call one provider reporting one date a conflict', () => {
    const v = decide(
      series({
        premiereDate: null,
        releaseDates: [{ releaseType: 'series_premiere', date: day(20), region: null, source: 'tvmaze' }],
      }),
    );
    expect(v.decision).toBe('auto_monitor');
  });
});

describe('returning series', () => {
  it('names a returning series as such rather than reporting it as simply old', () => {
    const v = decide(series({ premiereDate: '2022-11-13', seriesStatus: 'returning' }));
    expect(v.decision).toBe('review_past_release');
    expect(v.reason).toMatch(/returning series is not imported automatically/);
  });

  /*
   * Not ignored. An unowned returning series is a reasonable thing to want; it is
   * just not something to import on the system's own initiative.
   */
  it('reviews rather than ignores by default', () => {
    expect(decide(series({ premiereDate: '2022-11-13', seriesStatus: 'returning' })).decision)
      .toBe('review_past_release');
  });

  it('can be configured to file past releases away instead', () => {
    expect(decide(series({ premiereDate: '2022-11-13' }), { pastReleaseBehavior: 'ignore' }).decision)
      .toBe('ignore');
  });
});

describe('what the gate does not touch', () => {
  /*
   * "Monitor films once they reach streaming" is a documented, legitimate
   * configuration, and a film's digital date is routinely a year after its
   * theatrical one. Gating films on a past premiere would break it — for films
   * the release-type and window rules already define "upcoming".
   */
  it('does not gate a film on its theatrical premiere', () => {
    const v = decide({
      mediaType: 'movie',
      title: 'Example Film',
      genres: ['Sci-Fi'],
      identityStatus: 'resolved',
      confidence: 1,
      premiereDate: '2025-06-17',
      releaseDates: [{ releaseType: 'digital', date: day(30), region: 'US', source: 'tmdb' }],
    });
    expect(v.decision).toBe('auto_monitor');
  });

  it('leaves notify-only titles alone — the gate only blocks automation', () => {
    const v = decide(series({ premiereDate: '2022-01-01', genres: ['Drama'] }), {
      autoMonitorCategories: ['Sci-Fi'],
      notifyOnlyCategories: ['Drama'],
    });
    expect(v.decision).toBe('notify');
  });

  it('can be switched off deliberately, and only deliberately', () => {
    expect(decide(series({ premiereDate: '2022-01-01' }), { requireUpcoming: false }).decision)
      .toBe('auto_monitor');
    // The default is on: an operator who configured nothing is protected.
    expect(decide(series({ premiereDate: '2022-01-01' })).decision).toBe('review_past_release');
  });
});

/*
 * Retention mode.
 *
 * The window and the premiere gate are ADMISSION tests: "is this new enough to
 * start following?". Asked again of a show already monitored, they answer "no"
 * for the one reason guaranteed to happen to every show — time passing — and
 * that verdict reaches the retraction branch, which deletes the generated rule
 * of a series mid-season.
 *
 * So `retaining` skips exactly those two, and nothing else.
 */
describe('re-judging a show this template already monitors', () => {
  const premiered = series({
    releaseDates: [{ releaseType: 'series_premiere', date: day(-400), region: 'US' }],
  });

  it('would drop it on the way in — its premiere is long past', () => {
    const verdict = evaluateDiscovery(premiered, TEMPLATE, { now: NOW });
    expect(verdict.decision).not.toBe('auto_monitor');
  });

  it('keeps monitoring it when retaining', () => {
    const verdict = evaluateDiscovery(premiered, TEMPLATE, { now: NOW, retaining: true });
    expect(verdict.applies).toBe(true);
    expect(verdict.decision).toBe('auto_monitor');
  });

  it('says in the trace that the gates were skipped rather than passed', () => {
    const verdict = evaluateDiscovery(premiered, TEMPLATE, { now: NOW, retaining: true });
    const steps = verdict.trace.filter((t) => t.step === 'release_window' || t.step === 'upcoming_eligibility');
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s.status).toBe('info');
      expect(s.detail).toMatch(/admission test/);
    }
  });

  /*
   * The half that must NOT be skipped. Retention protects a show from the clock,
   * never from the policy: a genre the operator removed is a real answer, and
   * monitoring it withdraws.
   */
  it('still withdraws when the title itself stopped qualifying', () => {
    const verdict = evaluateDiscovery(
      series({
        genres: ['Cooking'],
        releaseDates: [{ releaseType: 'series_premiere', date: day(-400), region: 'US' }],
      }),
      TEMPLATE,
      { now: NOW, retaining: true },
    );
    expect(verdict.decision).not.toBe('auto_monitor');
  });

  it('still respects a language the template does not accept', () => {
    const verdict = evaluateDiscovery(
      { ...premiered, originalLanguage: 'ja' },
      { ...TEMPLATE, languages: ['en'] },
      { now: NOW, retaining: true },
    );
    expect(verdict.applies).toBe(false);
  });
});
