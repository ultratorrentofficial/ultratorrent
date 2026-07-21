/**
 * Redaction & error-sanitization for the Jobs Center. Job inputs, results, events,
 * and diagnostics are user-visible, so anything persisted or emitted must be
 * scrubbed of secrets first. Central so every surface (event log, result summary,
 * diagnostics export) uses the same rules. See the SECURITY threat model.
 */

/** Object keys whose values are always replaced with a redaction marker. */
const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[_-]?key|apikey|authorization|auth|credential|cookie|session|bearer|private[_-]?key|encryption[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|salt|hash|otp|totp|mfa|pin|signature)/i;

export const REDACTED = '[redacted]';

const MAX_DEPTH = 6;
const MAX_STRING = 2000;
const MAX_ARRAY = 200;

/**
 * Recursively redact secret-looking keys and truncate oversized values from an
 * arbitrary structure, returning a bounded, safe-to-persist copy. Never throws;
 * unrepresentable values become a string. Bounded in depth, string length, and
 * array size to keep persisted summaries small.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY} more)`);
    return out;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }

  // Functions, symbols, bigint, etc. — never persist raw.
  return String(value).slice(0, MAX_STRING);
}

/** A sanitized error safe to store on a job / show to an authorized user. */
export interface SanitizedError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Convert a thrown value into a sanitized error. Strips stack traces (they can
 * carry filesystem paths and internals) and redacts any structured details.
 * Recognizes an optional `code`/`details` on Error subclasses.
 */
export function sanitizeError(err: unknown): SanitizedError {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: unknown; details?: unknown };
    const code = typeof anyErr.code === 'string' ? anyErr.code : err.name || 'Error';
    const message = redactMessage(err.message || 'Unknown error');
    const details =
      anyErr.details && typeof anyErr.details === 'object'
        ? (redact(anyErr.details) as Record<string, unknown>)
        : undefined;
    return { code, message, details };
  }
  return { code: 'Error', message: redactMessage(String(err)) };
}

/** Redact secret-looking `key=value` / `key: value` fragments inside a free-text message. */
export function redactMessage(message: string): string {
  const trimmed = message.length > MAX_STRING ? message.slice(0, MAX_STRING) + '…' : message;
  return trimmed.replace(
    /\b([\w-]*(?:pass(?:word)?|secret|token|api[_-]?key|authorization|bearer|credential|key)[\w-]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    (_m, key: string) => `${key}=${REDACTED}`,
  );
}
