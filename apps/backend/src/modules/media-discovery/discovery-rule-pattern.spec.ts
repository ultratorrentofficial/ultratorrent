import { AcquisitionTemplateService } from './acquisition-template.service';
import { showTitleMatch } from '../rss/match-engine';

/**
 * A generated rule must be a rule about ONE show.
 *
 * `smart_episode_match` identifies the show through its `pattern`, and
 * `showTitleMatch` treats an empty pattern as "matches anything" — right for a
 * hand-made rule taking a whole feed, catastrophic for one generated per show. A
 * ladder is generic and carries no pattern, so cloning it verbatim produced
 * rules that grabbed every item in the feed passing their quality rules.
 */

const svc = new AcquisitionTemplateService({} as never, {} as never);

const ladder = (over: Partial<Record<string, unknown>> = {}) => ({
  requiredTerms: [],
  excludedTerms: [],
  candidates: [
    {
      priorityOrder: 0, name: '1080p x265', description: null, enabled: true,
      matchType: 'smart_episode_match', pattern: null,
      requiredTerms: [], excludedTerms: [], qualityRules: { resolution: '1080p' },
      sizeRules: {}, feedScope: {}, ...over,
    },
  ],
}) as never;

describe('the generated candidate carries the show title', () => {
  it('sets the pattern from the subject, not the ladder', () => {
    const [c] = svc.toRuleCandidates(ladder(), 'r1', { title: 'Crystal Lake', mediaType: 'tv' });
    expect(c.pattern).toBe('Crystal Lake');
  });

  /* The bug, stated as the property that failed. */
  it('never emits an empty pattern', () => {
    const [c] = svc.toRuleCandidates(ladder(), 'r1', { title: 'Carrie', mediaType: 'tv' });
    expect(String(c.pattern ?? '')).not.toBe('');
  });

  it('overrides a pattern the ladder happened to carry, because a ladder cannot know the show', () => {
    const [c] = svc.toRuleCandidates(
      ladder({ pattern: '12 12 12' }), 'r1', { title: 'Carrie', mediaType: 'tv' },
    );
    expect(c.pattern).toBe('Carrie');
  });

  it('keeps an explicit regex from the ladder, which is a deliberate choice', () => {
    const [c] = svc.toRuleCandidates(
      ladder({ matchType: 'regex', pattern: '^Carrie\\\\.S\\\\d\\\\d' }), 'r1',
      { title: 'Carrie', mediaType: 'tv' },
    );
    expect(c.matchType).toBe('regex');
    expect(c.pattern).toBe('^Carrie\\\\.S\\\\d\\\\d');
  });

  it('falls back to the title when a text match carries no pattern', () => {
    const [c] = svc.toRuleCandidates(
      ladder({ matchType: 'contains_text', pattern: '' }), 'r1',
      { title: 'Carrie', mediaType: 'tv' },
    );
    expect(c.pattern).toBe('Carrie');
  });

  it('uses the movie matcher for a film, whatever the ladder says', () => {
    const [c] = svc.toRuleCandidates(ladder(), 'r1', { title: 'Dune', mediaType: 'movie' });
    expect(c.matchType).toBe('smart_movie_match');
    expect(c.pattern).toBe('Dune');
  });

  /* Without a subject the ladder is cloned verbatim — the acquisition-template
   * editor's own preview, which is not about any one show. */
  it('leaves the ladder alone when there is no subject', () => {
    const [c] = svc.toRuleCandidates(ladder(), 'r1');
    expect(c.pattern).toBeNull();
  });
});

describe('what the matcher does with these patterns', () => {
  /* The reason an empty pattern is catastrophic, asserted directly. */
  it('an empty pattern matches an unrelated release', () => {
    expect(showTitleMatch('', 'Some.Other.Show.S01E01.1080p.WEB-DL.x265')).toBe(true);
  });

  it('the generated pattern matches its own show', () => {
    const [c] = svc.toRuleCandidates(ladder(), 'r1', { title: 'Crystal Lake', mediaType: 'tv' });
    expect(showTitleMatch(String(c.pattern), 'Crystal.Lake.S01E01.1080p.WEB-DL.x265-MeGusta')).toBe(true);
  });

  it('and rejects a different show', () => {
    const [c] = svc.toRuleCandidates(ladder(), 'r1', { title: 'Crystal Lake', mediaType: 'tv' });
    expect(showTitleMatch(String(c.pattern), 'Coven.Academy.S01E01.1080p.WEB-DL.x265-MeGusta')).toBe(false);
  });
});
