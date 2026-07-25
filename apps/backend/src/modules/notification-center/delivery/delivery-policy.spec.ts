import {
  classifyHttpStatus, classifyThrown, decideRetry, isRetryable,
  MAX_ATTEMPTS, nextAttemptDelayMs, parseRetryAfter, terminalStatusFor,
} from './delivery-policy';

describe('error classification', () => {
  it('classifies HTTP responses', () => {
    expect(classifyHttpStatus(401)).toBe('invalid_credentials');
    expect(classifyHttpStatus(403)).toBe('forbidden');
    expect(classifyHttpStatus(404)).toBe('invalid_destination');
    expect(classifyHttpStatus(400)).toBe('malformed_payload');
    expect(classifyHttpStatus(429)).toBe('rate_limited');
    expect(classifyHttpStatus(500)).toBe('provider_unavailable');
    expect(classifyHttpStatus(503)).toBe('provider_unavailable');
  });

  it('treats credential and destination failures as TERMINAL', () => {
    // Retrying a revoked token cannot change the outcome, and hammering one is
    // exactly what gets an integration banned.
    for (const cls of ['invalid_credentials', 'forbidden', 'invalid_destination', 'malformed_payload'] as const) {
      expect(isRetryable(cls)).toBe(false);
    }
  });

  it('treats transient failures as retryable', () => {
    for (const cls of ['timeout', 'rate_limited', 'provider_unavailable', 'network'] as const) {
      expect(isRetryable(cls)).toBe(true);
    }
  });

  it('retries an UNKNOWN error rather than dropping the notification', () => {
    // An unclassified error is more often a blip than a permanent rejection, and a
    // bounded retry costs less than losing a real notification.
    expect(isRetryable('unknown')).toBe(true);
  });

  it('classifies thrown network/timeout errors', () => {
    expect(classifyThrown(new Error('The operation was aborted'))).toBe('timeout');
    expect(classifyThrown(new Error('ETIMEDOUT'))).toBe('timeout');
    expect(classifyThrown(new Error('getaddrinfo ENOTFOUND discord.com'))).toBe('network');
    expect(classifyThrown(new Error('ECONNREFUSED'))).toBe('network');
    expect(classifyThrown(new Error('something odd'))).toBe('unknown');
  });

  it('maps a credential failure to invalid_connection, not a generic failure', () => {
    // The distinction drives the UI: the user must be told to reconnect.
    expect(terminalStatusFor('invalid_credentials')).toBe('invalid_connection');
    expect(terminalStatusFor('invalid_destination')).toBe('invalid_connection');
    expect(terminalStatusFor('timeout')).toBe('failed');
  });
});

describe('backoff', () => {
  const noJitter = () => 0.5; // centre of the ±25% band

  it('grows exponentially', () => {
    const a1 = nextAttemptDelayMs(1, null, noJitter);
    const a2 = nextAttemptDelayMs(2, null, noJitter);
    const a3 = nextAttemptDelayMs(3, null, noJitter);
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
    expect(a2 / a1).toBeCloseTo(2, 1);
  });

  it('is capped so a delivery is never scheduled absurdly far out', () => {
    expect(nextAttemptDelayMs(50, null, noJitter)).toBeLessThanOrEqual(60 * 60_000);
  });

  it('applies jitter, so a provider outage does not retry everything at once', () => {
    // Without jitter, 100 deliveries failing together would retry together and
    // re-create the herd that caused the outage.
    const low = nextAttemptDelayMs(3, null, () => 0);
    const high = nextAttemptDelayMs(3, null, () => 1);
    expect(low).not.toBe(high);
    expect(high).toBeGreaterThan(low);
  });

  it('lets the provider Retry-After win over our own guess', () => {
    // A provider telling us when to come back is better information, and ignoring
    // it is how a rate limit becomes a ban.
    expect(nextAttemptDelayMs(1, 120, noJitter)).toBe(120_000);
  });

  it('parses Retry-After as seconds or as a date', () => {
    expect(parseRetryAfter('30')).toBe(30);
    const now = Date.parse('2026-07-25T00:00:00Z');
    expect(parseRetryAfter('Sat, 25 Jul 2026 00:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('nonsense')).toBeNull();
  });
});

describe('decideRetry', () => {
  const fixed = () => 0.5;

  it('schedules a retry for a transient failure', () => {
    const d = decideRetry('timeout', 1, null, fixed);
    expect(d).toMatchObject({ retry: true, status: 'retry_scheduled', deadLetter: false });
    expect(d.delayMs).toBeGreaterThan(0);
  });

  it('does not retry a terminal failure, and dead-letters it', () => {
    expect(decideRetry('invalid_credentials', 1, null, fixed)).toMatchObject({
      retry: false, status: 'invalid_connection', deadLetter: true,
    });
  });

  it('stops at the attempt ceiling and dead-letters', () => {
    expect(decideRetry('timeout', MAX_ATTEMPTS, null, fixed)).toMatchObject({
      retry: false, status: 'failed', deadLetter: true,
    });
  });

  it('retries right up to the ceiling but not past it', () => {
    expect(decideRetry('timeout', MAX_ATTEMPTS - 1, null, fixed).retry).toBe(true);
    expect(decideRetry('timeout', MAX_ATTEMPTS, null, fixed).retry).toBe(false);
  });

  it('honours Retry-After on a rate limit', () => {
    expect(decideRetry('rate_limited', 1, 45, fixed).delayMs).toBe(45_000);
  });
});
