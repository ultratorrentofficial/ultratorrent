import { REDACTED, redact, redactMessage, sanitizeError } from './job-redaction';

describe('redact', () => {
  it('redacts secret-looking keys at any depth', () => {
    const out = redact({
      username: 'alice',
      password: 'hunter2',
      nested: { apiKey: 'abc', token: 'xyz', keep: 1 },
      list: [{ authorization: 'Bearer z' }],
    }) as Record<string, unknown>;
    expect(out.username).toBe('alice');
    expect(out.password).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).token).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).keep).toBe(1);
    expect(((out.list as unknown[])[0] as Record<string, unknown>).authorization).toBe(REDACTED);
  });

  it('matches common secret key spellings', () => {
    const out = redact({
      api_key: 'x', 'api-key': 'x', clientSecret: 'x', refresh_token: 'x',
      ENCRYPTION_KEY: 'x', sessionId: 'x', cookie: 'x', pin: 'x',
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  it('truncates oversized strings and arrays and caps depth', () => {
    const big = 'a'.repeat(5000);
    expect((redact(big) as string).endsWith('…')).toBe(true);
    expect((redact(big) as string).length).toBeLessThan(5000);

    const arr = Array.from({ length: 500 }, (_, i) => i);
    const out = redact(arr) as unknown[];
    expect(out.length).toBeLessThan(500);
    expect(String(out[out.length - 1])).toContain('more');

    // Deeply nested → truncated, never throws.
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('passes through primitives and null', () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });
});

describe('sanitizeError', () => {
  it('strips stack, keeps code + redacted message', () => {
    const e = new Error('boom with token=abcdef');
    const s = sanitizeError(e);
    expect(s.code).toBe('Error');
    expect(s.message).toContain('token=' + REDACTED);
    expect(JSON.stringify(s)).not.toContain('abcdef');
    expect((s as unknown as { stack?: string }).stack).toBeUndefined();
  });

  it('reads a custom code + redacts structured details', () => {
    const e = Object.assign(new Error('nope'), { code: 'E_PROVIDER', details: { apiKey: 'secret', status: 500 } });
    const s = sanitizeError(e);
    expect(s.code).toBe('E_PROVIDER');
    expect(s.details?.apiKey).toBe(REDACTED);
    expect(s.details?.status).toBe(500);
  });

  it('handles non-Error throwables', () => {
    expect(sanitizeError('string failure').message).toBe('string failure');
    expect(sanitizeError(undefined).code).toBe('Error');
  });
});

describe('redactMessage', () => {
  it('redacts inline secret fragments', () => {
    expect(redactMessage('failed: password=hunter2 next')).toContain('password=' + REDACTED);
    expect(redactMessage('Authorization: Bearer xyz')).toContain(REDACTED);
    expect(redactMessage('all good')).toBe('all good');
  });
});
