import type { MediaLifecyclePolicy } from '@ultratorrent/shared';

import { policyApplies, resolveDesiredState } from './policy-precedence';
import type { LifecycleMatchContext } from './policy-precedence';

/**
 * Policy precedence and dimension inheritance.
 *
 * This is the file that has to be right. Everything downstream — drift,
 * recommendations, and eventually Phase 6's executor — trusts that "what does
 * the operator want for this entity" has exactly one answer, arrived at the
 * same way every time, and able to say which policy supplied it.
 *
 * The cases below are the ones a later refactor would quietly break:
 * inheritance being all-or-nothing instead of per-dimension, a disabled
 * override pinning a value instead of falling through, `do_not_manage` being
 * confused with "no opinion", and an ambiguous configuration being resolved
 * silently rather than reported.
 */

const NOW = new Date('2026-09-16T12:00:00.000Z');

const policy = (over: Partial<MediaLifecyclePolicy> = {}): MediaLifecyclePolicy => ({
  id: over.id ?? 'p1',
  name: over.name ?? 'Policy',
  description: null,
  enabled: over.enabled ?? true,
  scopeType: over.scopeType ?? 'global',
  scopeId: over.scopeId ?? null,
  mode: over.mode ?? 'recommend_only',
  quality: over.quality ?? null,
  completeness: over.completeness ?? null,
  subtitleLanguages: over.subtitleLanguages ?? null,
  acquisition: over.acquisition ?? null,
  createdBy: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

/** Breaking Bad: a series, in the TV library, of kind `tv`. */
const series: LifecycleMatchContext = {
  entityType: 'series',
  entityId: 'show-1',
  libraryId: 'lib-tv',
  mediaKind: 'tv',
};

describe('policyApplies', () => {
  it('a global policy reaches everything', () => {
    expect(policyApplies(policy({ scopeType: 'global' }), series)).toBe(true);
  });

  it('a library policy reaches only its own library', () => {
    expect(policyApplies(policy({ scopeType: 'library', scopeId: 'lib-tv' }), series)).toBe(true);
    expect(policyApplies(policy({ scopeType: 'library', scopeId: 'lib-movies' }), series)).toBe(false);
  });

  it('a media-kind policy reaches only its own kind', () => {
    expect(policyApplies(policy({ scopeType: 'media_kind', scopeId: 'tv' }), series)).toBe(true);
    expect(policyApplies(policy({ scopeType: 'media_kind', scopeId: 'movie' }), series)).toBe(false);
  });

  it('a series policy reaches the show and anything beneath it', () => {
    const p = policy({ scopeType: 'series', scopeId: 'show-1' });
    expect(policyApplies(p, series)).toBe(true);
    // An episode carries its show id, so the series policy still governs it.
    expect(policyApplies(p, { entityType: 'episode', entityId: 'ep-9', showId: 'show-1' })).toBe(true);
    expect(policyApplies(p, { entityType: 'episode', entityId: 'ep-9', showId: 'other' })).toBe(false);
  });

  it('a movie policy never reaches a series, and vice versa', () => {
    expect(policyApplies(policy({ scopeType: 'movie', scopeId: 'show-1' }), series)).toBe(false);
    const movie: LifecycleMatchContext = { entityType: 'movie', entityId: 'm-1', mediaKind: 'movie' };
    expect(policyApplies(policy({ scopeType: 'series', scopeId: 'm-1' }), movie)).toBe(false);
  });

  it('a scoped policy cannot reach an entity whose scope is unknown', () => {
    // No libraryId on the context — a library policy must not match by default.
    const orphan: LifecycleMatchContext = { entityType: 'series', entityId: 'show-9' };
    expect(policyApplies(policy({ scopeType: 'library', scopeId: 'lib-tv' }), orphan)).toBe(false);
    expect(policyApplies(policy({ scopeType: 'media_kind', scopeId: 'tv' }), orphan)).toBe(false);
  });
});

describe('resolveDesiredState — applicability', () => {
  it('resolves to nothing when no policy exists', () => {
    const r = resolveDesiredState([], series, NOW);
    expect(r.quality.value).toBeNull();
    expect(r.quality.source).toBeNull();
    expect(r.mode).toBeNull();
    expect(r.applicablePolicies).toEqual([]);
  });

  it('ignores a disabled policy entirely', () => {
    const r = resolveDesiredState(
      [policy({ id: 'g', quality: 'maintain_preferred', enabled: false })],
      series,
      NOW,
    );
    expect(r.quality.value).toBeNull();
  });

  it('ignores a policy scoped to something else', () => {
    const r = resolveDesiredState(
      [policy({ id: 'other', scopeType: 'library', scopeId: 'lib-movies', quality: 'maintain_preferred' })],
      series,
      NOW,
    );
    expect(r.quality.value).toBeNull();
  });
});

describe('resolveDesiredState — precedence', () => {
  it('a library policy beats a global one', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', name: 'Global', quality: 'maintain_acceptable' }),
        policy({ id: 'l', name: 'TV Library', scopeType: 'library', scopeId: 'lib-tv', quality: 'maintain_preferred' }),
      ],
      series,
      NOW,
    );
    expect(r.quality.value).toBe('maintain_preferred');
    expect(r.quality.source?.policyId).toBe('l');
  });

  it('a library policy beats a media-kind one', () => {
    // A library is a concrete thing the operator created; a kind is a class.
    const r = resolveDesiredState(
      [
        policy({ id: 'k', scopeType: 'media_kind', scopeId: 'tv', quality: 'maintain_acceptable' }),
        policy({ id: 'l', scopeType: 'library', scopeId: 'lib-tv', quality: 'maintain_preferred' }),
      ],
      series,
      NOW,
    );
    expect(r.quality.source?.policyId).toBe('l');
  });

  it('a series policy beats everything', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', quality: 'maintain_acceptable' }),
        policy({ id: 'l', scopeType: 'library', scopeId: 'lib-tv', quality: 'maintain_acceptable' }),
        policy({ id: 's', scopeType: 'series', scopeId: 'show-1', quality: 'maintain_preferred' }),
      ],
      series,
      NOW,
    );
    expect(r.quality.source?.policyId).toBe('s');
  });

  it('is independent of the order the policies arrive in', () => {
    const list = [
      policy({ id: 'g', quality: 'maintain_acceptable' }),
      policy({ id: 's', scopeType: 'series', scopeId: 'show-1', quality: 'maintain_preferred' }),
      policy({ id: 'l', scopeType: 'library', scopeId: 'lib-tv', quality: 'do_not_manage' }),
    ];
    const a = resolveDesiredState(list, series, NOW);
    const b = resolveDesiredState([...list].reverse(), series, NOW);
    expect(a.quality.value).toBe(b.quality.value);
    expect(a.quality.source?.policyId).toBe(b.quality.source?.policyId);
    // Never DB row order, never createdAt — the scope order decides.
    expect(a.quality.source?.policyId).toBe('s');
  });
});

describe('resolveDesiredState — dimension-level inheritance', () => {
  it('an override is a patch, not a replacement', () => {
    const r = resolveDesiredState(
      [
        policy({
          id: 'g', name: 'Global',
          quality: 'maintain_preferred',
          completeness: 'maintain_aired',
          subtitleLanguages: ['en'],
        }),
        // Mentions ONLY subtitles.
        policy({ id: 's', name: 'Spanish Shows', scopeType: 'series', scopeId: 'show-1', subtitleLanguages: ['en', 'es'] }),
      ],
      series,
      NOW,
    );

    expect(r.subtitleLanguages.value).toEqual(['en', 'es']);
    expect(r.subtitleLanguages.source?.policyId).toBe('s');
    expect(r.subtitleLanguages.inherited).toBe(false);

    // The dimensions the series policy said nothing about survive.
    expect(r.quality.value).toBe('maintain_preferred');
    expect(r.quality.source?.policyId).toBe('g');
    expect(r.quality.inherited).toBe(true);
    expect(r.completeness.value).toBe('maintain_aired');
  });

  it('records what was overridden, not just what won', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', name: 'Global', subtitleLanguages: ['en'] }),
        policy({ id: 's', name: 'Override', scopeType: 'series', scopeId: 'show-1', subtitleLanguages: ['en', 'es'] }),
      ],
      series,
      NOW,
    );
    expect(r.subtitleLanguages.overridden).toEqual([
      { policyId: 'g', policyName: 'Global', scopeType: 'global', value: ['en'] },
    ]);
  });

  it('treats `do_not_manage` as a decision that STOPS inheritance', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', quality: 'maintain_preferred' }),
        policy({ id: 's', scopeType: 'series', scopeId: 'show-1', quality: 'do_not_manage' }),
      ],
      series,
      NOW,
    );
    // Not the same as saying nothing: the global intent must NOT leak through.
    expect(r.quality.value).toBe('do_not_manage');
    expect(r.quality.source?.policyId).toBe('s');
  });

  it('treats an empty language list as explicitly none, not as silence', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', subtitleLanguages: ['en'] }),
        policy({ id: 's', scopeType: 'series', scopeId: 'show-1', subtitleLanguages: [] }),
      ],
      series,
      NOW,
    );
    expect(r.subtitleLanguages.value).toEqual([]);
    expect(r.subtitleLanguages.source?.policyId).toBe('s');
  });

  it('lets a disabled narrower policy expose the inherited value', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', quality: 'maintain_acceptable' }),
        policy({ id: 's', scopeType: 'series', scopeId: 'show-1', quality: 'maintain_preferred', enabled: false }),
      ],
      series,
      NOW,
    );
    expect(r.quality.value).toBe('maintain_acceptable');
    expect(r.quality.source?.policyId).toBe('g');
  });
});

describe('resolveDesiredState — conflicts', () => {
  it('reports two equally-specific policies that disagree', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'a', name: 'A', scopeType: 'library', scopeId: 'lib-tv', subtitleLanguages: ['en'] }),
        policy({ id: 'b', name: 'B', scopeType: 'library', scopeId: 'lib-tv', subtitleLanguages: ['es'] }),
      ],
      series,
      NOW,
    );

    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].dimension).toBe('subtitleLanguages');
    expect(r.conflicts[0].scopeType).toBe('library');
    expect(r.conflicts[0].contenders.map((c) => c.policyId).sort()).toEqual(['a', 'b']);
    // Still deterministic despite the conflict — the system must not flicker.
    expect(r.subtitleLanguages.value).toEqual(['en']);
  });

  it('does not report a conflict when equally-specific policies AGREE', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'a', scopeType: 'library', scopeId: 'lib-tv', subtitleLanguages: ['en'] }),
        policy({ id: 'b', scopeType: 'library', scopeId: 'lib-tv', subtitleLanguages: ['en'] }),
      ],
      series,
      NOW,
    );
    expect(r.conflicts).toEqual([]);
  });

  it('does not report a conflict across DIFFERENT scopes — that is precedence', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', quality: 'maintain_acceptable' }),
        policy({ id: 's', scopeType: 'series', scopeId: 'show-1', quality: 'maintain_preferred' }),
      ],
      series,
      NOW,
    );
    expect(r.conflicts).toEqual([]);
  });
});

describe('resolveDesiredState — mode', () => {
  it('takes the strictest mode among policies that actually contributed', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', quality: 'maintain_preferred', mode: 'recommend_only' }),
        policy({ id: 's', scopeType: 'series', scopeId: 'show-1', subtitleLanguages: ['es'], mode: 'approval_required' }),
      ],
      series,
      NOW,
    );
    expect(r.mode).toBe('approval_required');
  });

  it('ignores the mode of a policy whose every dimension was overridden', () => {
    // `g` contributes nothing once the series policy wins quality, so its
    // stricter mode must not govern an entity it no longer influences.
    const r = resolveDesiredState(
      [
        policy({ id: 'g', quality: 'maintain_acceptable', mode: 'approval_required' }),
        policy({ id: 's', scopeType: 'series', scopeId: 'show-1', quality: 'maintain_preferred', mode: 'recommend_only' }),
      ],
      series,
      NOW,
    );
    expect(r.mode).toBe('recommend_only');
  });

  it('is null when nothing applies', () => {
    expect(resolveDesiredState([], series, NOW).mode).toBeNull();
  });
});

describe('resolveDesiredState — explainability', () => {
  it('lists every applicable policy, most specific first', () => {
    const r = resolveDesiredState(
      [
        policy({ id: 'g', name: 'Global' }),
        policy({ id: 's', name: 'Series', scopeType: 'series', scopeId: 'show-1' }),
        policy({ id: 'l', name: 'Library', scopeType: 'library', scopeId: 'lib-tv' }),
        policy({ id: 'x', name: 'Elsewhere', scopeType: 'library', scopeId: 'lib-other' }),
      ],
      series,
      NOW,
    );
    expect(r.applicablePolicies.map((p) => p.policyId)).toEqual(['s', 'l', 'g']);
  });

  it('stamps the clock it was given, never wall time', () => {
    expect(resolveDesiredState([], series, NOW).evaluatedAt).toBe('2026-09-16T12:00:00.000Z');
  });
});
