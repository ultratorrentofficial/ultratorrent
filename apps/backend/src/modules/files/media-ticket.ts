/**
 * Short-lived, path-scoped grants for the byte-streaming route.
 *
 * `<img src>`, `<video src>` and an inline PDF frame cannot carry an
 * `Authorization` header, and the app holds its access token in localStorage —
 * there is no cookie for the browser to attach on its own. Fetching the whole
 * file into a blob works for a photo and is untenable for a 40 GB remux: it
 * forfeits Range requests, so nothing plays until everything has downloaded.
 *
 * So the caller — already authenticated and permission-checked — mints a ticket
 * for ONE path, and the stream route accepts that ticket in the query string.
 *
 * Signed rather than stored: a stateless HMAC survives a restart and a second
 * replica, where a Map would hand out tickets one instance cannot honour.
 *
 * Pure and IO-free.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How long a ticket stays valid.
 *
 * This is a playback session, not a request: a `<video>` re-requests ranges for
 * as long as someone is watching, and an expiry mid-film would stall the player.
 * Four hours covers the longest thing anyone would sit through, and the ticket
 * is scoped to a single path, so what a leaked URL exposes is that one file
 * until it lapses — not the account.
 */
export const MEDIA_TICKET_TTL_MS = 4 * 60 * 60 * 1000;

export interface MediaTicketPayload {
  /** Root-relative path this ticket authorises, and nothing else. */
  p: string;
  /** Who minted it — carried for attribution, never trusted for authorisation. */
  u?: string;
  /** Expiry, epoch ms. */
  x: number;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

/** Mint a ticket for one path. `now` is injected so tests need no clock. */
export function signMediaTicket(
  secret: string,
  payload: Omit<MediaTicketPayload, 'x'>,
  now = Date.now(),
  ttlMs = MEDIA_TICKET_TTL_MS,
): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, x: expiresAt }), 'utf8'));
  return { token: `${body}.${b64url(sign(secret, body))}`, expiresAt };
}

/**
 * Verify a ticket. Returns the payload, or `null` for anything wrong at all —
 * bad shape, bad signature, expired. The caller gets one bit back on purpose:
 * distinguishing "forged" from "expired" to an unauthenticated caller tells them
 * which half of the token to keep working on.
 *
 * The signature comparison is constant-time. A byte-by-byte early exit leaks how
 * much of a guessed signature was right, which is enough to forge one.
 */
export function verifyMediaTicket(
  secret: string,
  token: string | undefined | null,
  now = Date.now(),
): MediaTicketPayload | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = sign(secret, body);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: MediaTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MediaTicketPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.p !== 'string' || typeof payload.x !== 'number') return null;
  if (payload.x <= now) return null;
  return payload;
}
