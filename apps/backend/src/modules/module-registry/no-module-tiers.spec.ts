import { ALL_MANIFESTS } from './manifests';

/**
 * There are no module editions any more.
 *
 * `tier: 'core' | 'community'` conflated the edition a module belonged to with
 * whether it can be switched off. The editions were retired — everything ships
 * in one community build — but the field stayed, so the Modules page went on
 * grouping modules under "Core" and "Community" headings describing a product
 * that no longer exists.
 */
describe('modules have no tier', () => {
  it('every manifest declares whether it is required, as a boolean', () => {
    for (const m of ALL_MANIFESTS) {
      expect(`${m.id}:${typeof m.required}`).toBe(`${m.id}:boolean`);
    }
  });

  it('no manifest carries a tier field at all', () => {
    const withTier = ALL_MANIFESTS.filter((m) => 'tier' in (m as unknown as Record<string, unknown>));
    expect(withTier.map((m) => m.id)).toEqual([]);
  });

  /** The lock is real and load-bearing — the point was to rename it, not remove it. */
  it('still marks the modules the system cannot run without', () => {
    const required = ALL_MANIFESTS.filter((m) => m.required).map((m) => m.id);
    expect(required.length).toBeGreaterThan(0);
    expect(required).toContain('auth');
  });

  it('leaves some modules optional, or the toggle would be decorative', () => {
    expect(ALL_MANIFESTS.filter((m) => !m.required).length).toBeGreaterThan(0);
  });
});
