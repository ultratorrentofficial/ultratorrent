import { describe, expect, it } from 'vitest';
import { bulkLevel, failureReasons, isBulkResult, type BulkResult } from './bulk-result';

const res = (over: Partial<BulkResult> = {}): BulkResult => ({
  total: 2,
  succeeded: 2,
  failed: 0,
  results: [
    { path: '/a.mkv', ok: true },
    { path: '/b.mkv', ok: true },
  ],
  ...over,
});

describe('isBulkResult', () => {
  it('accepts a bulk envelope', () => {
    expect(isBulkResult(res())).toBe(true);
  });

  /**
   * The single-item endpoints resolve to their own shapes, and the old bulk test
   * stubbed `{}` — none of which carry per-item outcomes. Narrowing must reject
   * them so a shared runner falls back to "resolved means success".
   */
  it.each([[{}], [null], [undefined], [{ ok: true, path: '/a.mkv' }], [{ failed: 1 }], ['nope']])(
    'rejects a non-bulk result: %j',
    (value) => {
      expect(isBulkResult(value)).toBe(false);
    },
  );
});

describe('bulkLevel', () => {
  it('is success only when nothing failed', () => {
    expect(bulkLevel(res())).toBe('success');
  });

  it('is partial when some succeeded and some failed', () => {
    expect(bulkLevel(res({ succeeded: 1, failed: 1 }))).toBe('partial');
  });

  // The case that shipped as "Moved 2 items": 200, but nothing moved.
  it('is failed when nothing succeeded', () => {
    expect(bulkLevel(res({ succeeded: 0, failed: 2 }))).toBe('failed');
  });
});

describe('failureReasons', () => {
  it('collapses one shared reason to a single mention', () => {
    const r = res({
      succeeded: 0,
      failed: 2,
      results: [
        { path: '/a.mkv', ok: false, message: 'Destination already exists' },
        { path: '/b.mkv', ok: false, message: 'Destination already exists' },
      ],
    });
    expect(failureReasons(r)).toBe('Destination already exists');
  });

  it('lists distinct reasons together', () => {
    const r = res({
      succeeded: 0,
      failed: 2,
      results: [
        { path: '/a.mkv', ok: false, message: 'Destination already exists' },
        { path: '/b.mkv', ok: false, message: 'Item not found' },
      ],
    });
    expect(failureReasons(r)).toBe('Destination already exists · Item not found');
  });

  it('ignores succeeded items and messageless failures', () => {
    const r = res({
      succeeded: 1,
      failed: 1,
      results: [
        { path: '/a.mkv', ok: true, message: 'ignore me' },
        { path: '/b.mkv', ok: false },
      ],
    });
    // Empty, so the caller falls back to its "{count} failed" string.
    expect(failureReasons(r)).toBe('');
  });
});
