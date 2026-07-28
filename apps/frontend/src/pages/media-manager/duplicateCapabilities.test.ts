import { describe, expect, it } from 'vitest';
import { duplicateCapabilities } from './duplicateCapabilities';

describe('duplicateCapabilities', () => {
  it('lets an open group be dismissed, not reopened', () => {
    expect(duplicateCapabilities({ status: 'open' })).toEqual(['ignorable']);
  });

  it('reopens an ignored group', () => {
    expect(duplicateCapabilities({ status: 'ignored' })).toEqual(['reopenable']);
  });

  it('also reopens a RESOLVED group', () => {
    /*
     * Checked against the service rather than assumed. Reopening a group whose
     * duplicates were already deleted looks wrong until you read its contract —
     * "put an ignored or resolved group back in front of the operator" — because
     * a resolution can be mistaken too. My first version withheld it.
     */
    expect(duplicateCapabilities({ status: 'resolved' })).toEqual(['reopenable']);
  });

  it('never offers both at once', () => {
    for (const status of ['open', 'ignored', 'resolved', 'nonsense']) {
      const caps = duplicateCapabilities({ status });
      expect(caps.includes('ignorable') && caps.includes('reopenable')).toBe(false);
    }
  });

  it('withholds both for a status it does not model', () => {
    // Guessing here either hides a real duplicate or resurrects a dismissed one.
    expect(duplicateCapabilities({ status: 'some_future_status' })).toEqual([]);
  });
});
