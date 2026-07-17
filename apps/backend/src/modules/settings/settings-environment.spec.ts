import { readEnvironment, ENVIRONMENT_CATALOG } from './settings-environment';

describe('readEnvironment', () => {
  it('never returns a value for secret entries (only set/not-set)', () => {
    const rows = readEnvironment({ ENCRYPTION_KEY: 'super-secret', DATABASE_URL: 'postgres://u:p@h/db' } as never);
    const enc = rows.find((r) => r.key === 'ENCRYPTION_KEY')!;
    expect(enc.secret).toBe(true);
    expect(enc.set).toBe(true);
    expect(enc.value).toBeNull(); // never leaked
  });

  it('returns the value for non-secret entries', () => {
    const rows = readEnvironment({ NODE_ENV: 'production', PORT: '4000' } as never);
    expect(rows.find((r) => r.key === 'NODE_ENV')!.value).toBe('production');
    expect(rows.find((r) => r.key === 'PORT')!.value).toBe('4000');
  });

  it('marks unset / empty vars as not set', () => {
    const rows = readEnvironment({ REDIS_HOST: '' } as never);
    expect(rows.find((r) => r.key === 'REDIS_HOST')!.set).toBe(false);
    expect(rows.find((r) => r.key === 'REDIS_PORT')!.set).toBe(false); // absent
  });

  it('covers every catalog entry, each with a group + description', () => {
    const rows = readEnvironment({} as never);
    expect(rows).toHaveLength(ENVIRONMENT_CATALOG.length);
    for (const r of rows) {
      expect(r.group).toBeTruthy();
      expect(r.description.length).toBeGreaterThan(10);
    }
  });
});
