import { normalizeUserName } from '../media/trakt/trakt-client';

/**
 * The name to CALL someone in a notification, as opposed to the handle their
 * media server happened to report.
 *
 * Plex answers two different questions with two different names. Its account list
 * gives the friendly one — synoplex knows `Dennis Ayala`, `Madeline Ayala`,
 * `Jonathan Medina`, 41 of them — while `/status/sessions` reports the owner as
 * `dennis.ayala`, a login. So every playback alert was addressed to a handle even
 * though the full name was already in our own database.
 *
 * For everyone EXCEPT the owner the id bridges them exactly — `madeline24` plays
 * under Plex account `19587074`, which the account list calls `Madeline Ayala`.
 * The owner is the exception: Plex numbers them `1` in a session and `383757` in
 * the account list, so only that one falls through to matching by name.
 *
 * The matching below is deliberately conservative — attributing one person's
 * viewing to another is a worse outcome than showing a handle.
 */

export interface KnownViewer {
  connectionId: string | null;
  providerUserId: string | null;
  userName: string;
}

export interface SessionViewer {
  connectionId: string;
  providerUserId: string | null;
  userName: string | null;
}

/**
 * Resolve a session's viewer to their friendly name, or return what the session
 * said when nothing matches with certainty.
 *
 * In order of confidence:
 *
 * 1. **Same connection, same provider id** — an exact identity, no inference.
 * 2. **The same provider id on an UNSCOPED account, and only one of them.** The
 *    account list is not necessarily synced per connection — synoplex's 41 rows
 *    all carry a null `connectionId` — and a null there means "not scoped to a
 *    server", not "belongs to a different one". Requiring the connection to match
 *    was what kept `jonathanxir` from resolving to `Jonathan Medina` even though
 *    both sides agree on account `24891625`. The single-match condition covers
 *    the one id that is NOT globally unique: every Plex server numbers its own
 *    owner `1`, so two connected servers would offer two rows, and neither wins.
 * 3. **Same name already** — nothing to resolve.
 * 4. **One, and only one, account whose name normalizes the same way.**
 *    `dennis.ayala` and `Dennis Ayala` both reduce to `dennisayala`; this is the
 *    same normalization the Trakt scrobbler already trusts to decide whose
 *    history a play belongs in. The single-match condition is the safeguard: two
 *    people who reduce to the same string resolve to neither.
 *
 * Anything else keeps the session's own name. Note what is NOT used: the account
 * emails. `jonathanxir` sits inside `jonathanxirizarry2014@gmail.com`, and
 * matching on that prefix would be a guess — the id already answers the question
 * exactly, so there is nothing for a guess to add.
 */
export function resolveViewerName(known: KnownViewer[], session: SessionViewer): string | null {
  const raw = session.userName;
  if (!raw) return null;

  if (session.providerUserId) {
    const sameId = known.filter((k) => k.providerUserId != null && k.providerUserId === session.providerUserId);
    const scoped = sameId.find((k) => k.connectionId === session.connectionId);
    if (scoped) return scoped.userName;
    const unscoped = sameId.filter((k) => k.connectionId == null);
    if (unscoped.length === 1) return unscoped[0].userName;
  }

  if (known.some((k) => k.userName === raw)) return raw;

  const key = normalizeUserName(raw);
  if (!key) return raw;
  const matches = known.filter((k) => normalizeUserName(k.userName) === key);
  return matches.length === 1 ? matches[0].userName : raw;
}
