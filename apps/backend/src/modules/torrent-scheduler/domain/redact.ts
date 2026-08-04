/**
 * Strip credentials out of a message before it leaves the process.
 *
 * A provider error is the most likely place for a secret to escape, because it
 * is written by a library that has no idea the string will travel. A failed
 * qBittorrent call can embed the base URL; an rTorrent one can name its SCGI
 * target; a tracker error can carry a passkey in a query string. None of that is
 * a problem in a log file on the operator's own box — but a scheduler event
 * reaches the automation engine, and from there a webhook to a third party.
 *
 * So this runs on the way INTO an event payload, not on the way into the log:
 * the log keeps the detail an operator needs to debug, and the event carries
 * only what a consumer needs to act.
 */

/** `passkey=…`, `apikey=…`, `token=…`, `auth=…` and friends, in a query string. */
const SECRET_PARAM = /\b(passkey|apikey|api_key|token|auth|secret|password|pwd|key)=[^&\s"']+/gi;

/** `scheme://user:pass@host` — the credentials, not the host. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

/** A whole URL. Kept coarse: the host alone can identify a private tracker. */
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;

/** A 32/40-character hex run that is not the torrent hash we already name. */
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;

/** How much of a message is worth carrying; the log keeps the rest. */
const MAX_LENGTH = 300;

/**
 * Redact and truncate.
 *
 * Deliberately aggressive. A message that loses a hostname is mildly less
 * useful; a message that carries a tracker passkey into a third-party webhook
 * is a credential leak, and the operator cannot un-send it.
 */
export function redactForEvent(message: string | undefined | null): string {
  if (!message) return '';
  const cleaned = message
    .replace(URL_CREDENTIALS, '$1<redacted>@')
    .replace(SECRET_PARAM, (m) => `${m.split('=')[0]}=<redacted>`)
    .replace(URL, '<url>')
    .replace(LONG_HEX, '<redacted>');

  return cleaned.length > MAX_LENGTH ? `${cleaned.slice(0, MAX_LENGTH)}…` : cleaned;
}
