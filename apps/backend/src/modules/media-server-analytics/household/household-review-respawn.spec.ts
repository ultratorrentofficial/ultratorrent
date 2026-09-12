import { HouseholdService } from './household.service';

/**
 * Regression: dispositioning a review (Trust / Dismiss) must be DURABLE. A
 * recompute that reproduces the same evidence the admin already judged must not
 * respawn a fresh open case — only a genuinely worse picture (a new signal, or a
 * higher risk level than the one reviewed) re-opens. Guards the bug where a
 * "Trusted" profile kept reappearing in the review queue, still marked critical.
 */
describe('HouseholdService review re-open decision (escalatedSince)', () => {
  // The predicate uses none of the injected collaborators.
  const svc = new HouseholdService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  const escalated = (
    prev: { riskLevel: string; reasons: unknown },
    cur: { level: 'none' | 'low' | 'medium' | 'high' | 'critical'; reasons: Array<{ code: string }> },
  ): boolean => (svc as unknown as { escalatedSince: typeof escalated }).escalatedSince(prev, cur);

  const reviewed = {
    riskLevel: 'critical',
    reasons: [{ code: 'simultaneous_residential_networks' }, { code: 'persistent_secondary_residential_network' }],
  };

  it('does NOT re-open when the same evidence is recomputed', () => {
    expect(
      escalated(reviewed, {
        level: 'critical',
        reasons: [{ code: 'simultaneous_residential_networks' }, { code: 'persistent_secondary_residential_network' }],
      }),
    ).toBe(false);
  });

  it('does NOT re-open when the picture is a strict subset of what was reviewed', () => {
    expect(escalated(reviewed, { level: 'high', reasons: [{ code: 'persistent_secondary_residential_network' }] })).toBe(
      false,
    );
  });

  it('re-opens when a signal the admin never saw appears', () => {
    expect(
      escalated(reviewed, {
        level: 'critical',
        reasons: [{ code: 'simultaneous_residential_networks' }, { code: 'new_hosting_network' }],
      }),
    ).toBe(true);
  });

  it('re-opens when the risk level rises above the reviewed one', () => {
    const reviewedHigh = { riskLevel: 'high', reasons: [{ code: 'persistent_secondary_residential_network' }] };
    expect(escalated(reviewedHigh, { level: 'critical', reasons: [{ code: 'persistent_secondary_residential_network' }] })).toBe(
      true,
    );
  });

  it('treats a missing/blank reviewed reasons list as "everything is new" (re-open)', () => {
    expect(escalated({ riskLevel: 'critical', reasons: null }, { level: 'critical', reasons: [{ code: 'x' }] })).toBe(true);
  });
});
