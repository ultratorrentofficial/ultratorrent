import { describe, expect, it } from 'vitest';
import { JOB_TABS, jobDuration, statusVariant } from './jobStatus';

describe('statusVariant', () => {
  it('maps active/terminal statuses to sensible tones', () => {
    expect(statusVariant('running')).toBe('info');
    expect(statusVariant('completed')).toBe('success');
    expect(statusVariant('completed_with_warnings')).toBe('warning');
    expect(statusVariant('failed')).toBe('destructive');
    expect(statusVariant('cancelled')).toBe('secondary');
    expect(statusVariant('paused')).toBe('warning');
  });
});

describe('JOB_TABS', () => {
  it('starts with All (no status) and covers the key statuses', () => {
    expect(JOB_TABS[0]).toEqual({ key: 'all' });
    const statuses = JOB_TABS.map((t) => t.status).filter(Boolean);
    expect(statuses).toEqual(['running', 'queued', 'waiting', 'scheduled', 'failed', 'completed', 'cancelled']);
  });
});

describe('jobDuration', () => {
  it('formats seconds/minutes/hours and handles missing start', () => {
    expect(jobDuration(null)).toBe('—');
    const base = '2026-07-21T10:00:00.000Z';
    expect(jobDuration(base, '2026-07-21T10:00:05.000Z')).toBe('5s');
    expect(jobDuration(base, '2026-07-21T10:02:05.000Z')).toBe('2m 5s');
    expect(jobDuration(base, '2026-07-21T12:30:00.000Z')).toBe('2h 30m');
  });
});
