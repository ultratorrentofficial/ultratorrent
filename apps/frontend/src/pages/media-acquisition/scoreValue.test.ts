import { describe, expect, it } from 'vitest';
import { scoreValue } from './MediaAcquisitionPage';

// Regression: an evaluation's `releaseScore` is a breakdown OBJECT
// ({ value, reasons, decision, warnings }), not a bare number. Rendering the
// object directly threw React error #31 ("Objects are not valid as a React
// child") on the Evaluations/Approvals views once any evaluation existed.
describe('scoreValue', () => {
  it('reads .value from the breakdown object (the real backend shape)', () => {
    expect(
      scoreValue({ value: 37, decision: 'skip', reasons: ['-12 resolution'], warnings: [] }),
    ).toBe(37);
  });

  it('tolerates a plain number', () => {
    expect(scoreValue(85)).toBe(85);
  });

  it('renders a dash for null/undefined or a missing value', () => {
    expect(scoreValue(null)).toBe('—');
    expect(scoreValue(undefined)).toBe('—');
    expect(scoreValue({ value: undefined as unknown as number })).toBe('—');
  });
});
