import type { NotificationDeliveryStatus } from '@ultratorrent/shared';

/**
 * Why a delivery failed, classified rather than guessed from a message.
 *
 * The distinction that matters is retryable vs terminal: retrying a terminal
 * failure (revoked token, invalid destination) burns attempts and rate limit for a
 * result that cannot change, while giving up on a transient one loses a
 * notification that would have arrived a minute later.
 */
export type DeliveryErrorClass =
  | 'timeout'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'network'
  | 'invalid_credentials'
  | 'invalid_destination'
  | 'forbidden'
  | 'malformed_payload'
  | 'unsupported_template'
  | 'unknown';

const RETRYABLE: readonly DeliveryErrorClass[] = [
  'timeout',
  'rate_limited',
  'provider_unavailable',
  'network',
  // `unknown` is retried deliberately: an unclassified error is more often a
  // transient blip than a permanent rejection, and a bounded retry costs little
  // while dropping a real notification costs the operator trust.
  'unknown',
];

export function isRetryable(cls: DeliveryErrorClass): boolean {
  return RETRYABLE.includes(cls);
}

/** Classify an HTTP status from a provider into a delivery error class. */
export function classifyHttpStatus(status: number): DeliveryErrorClass {
  if (status === 401 || status === 403) {
    // A revoked bot token or webhook returns these. Retrying cannot fix it, and
    // hammering a revoked credential is exactly what gets an app banned.
    return status === 401 ? 'invalid_credentials' : 'forbidden';
  }
  if (status === 404) return 'invalid_destination'; // deleted webhook / unknown chat
  if (status === 400 || status === 422) return 'malformed_payload';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

/** Classify a thrown error (no HTTP response). */
export function classifyThrown(err: unknown): DeliveryErrorClass {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (msg.includes('abort') || msg.includes('timeout') || msg.includes('etimedout')) return 'timeout';
  if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('eai_again')
      || msg.includes('econnreset') || msg.includes('network')) return 'network';
  return 'unknown';
}

/** Terminal status for an error class that will never succeed. */
export function terminalStatusFor(cls: DeliveryErrorClass): NotificationDeliveryStatus {
  switch (cls) {
    case 'invalid_credentials':
    case 'forbidden':
      return 'invalid_connection';
    case 'invalid_destination':
      return 'invalid_connection';
    default:
      return 'failed';
  }
}

/** Attempts before a delivery is dead-lettered. */
export const MAX_ATTEMPTS = 5;

/** Base backoff, doubling per attempt. */
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60 * 60_000; // an hour is long enough for any provider blip

/**
 * When to try again.
 *
 * Exponential with **jitter**: without it, a provider outage that fails a hundred
 * deliveries at once would retry all hundred at the same instant, re-creating the
 * thundering herd that caused the outage. Jitter is ±25%, which is enough to spread
 * a burst without making the schedule unpredictable to an operator reading it.
 *
 * `retryAfterSeconds` (from a provider's `Retry-After`) always wins — a provider
 * telling us when to come back is better information than our own guess, and
 * ignoring it is how a rate limit becomes a ban.
 */
export function nextAttemptDelayMs(
  attempt: number,
  retryAfterSeconds?: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterSeconds != null && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_DELAY_MS);
  }
  const exponential = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
  const jitter = 1 + (random() - 0.5) * 0.5; // ±25%
  return Math.round(Math.min(exponential * jitter, MAX_DELAY_MS));
}

/** The decision after one failed attempt. */
export interface RetryDecision {
  retry: boolean;
  status: NotificationDeliveryStatus;
  delayMs?: number;
  deadLetter: boolean;
}

export function decideRetry(
  cls: DeliveryErrorClass,
  attempt: number,
  retryAfterSeconds?: number | null,
  random: () => number = Math.random,
): RetryDecision {
  if (!isRetryable(cls)) {
    // Terminal: no further attempt, and dead-lettered so the failure survives
    // cleanup of the delivery row.
    return { retry: false, status: terminalStatusFor(cls), deadLetter: true };
  }
  if (attempt >= MAX_ATTEMPTS) {
    return { retry: false, status: 'failed', deadLetter: true };
  }
  return {
    retry: true,
    status: 'retry_scheduled',
    delayMs: nextAttemptDelayMs(attempt, retryAfterSeconds, random),
    deadLetter: false,
  };
}

/** Parse a `Retry-After` header (seconds, or an HTTP date). */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, Math.round((at - now) / 1000));
  return null;
}
