import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';

/** How long a code stays usable. Long enough to switch apps, short enough to matter. */
const CODE_TTL_MS = 10 * 60 * 1000;
/** Codes one user may request inside the window, before they must wait. */
const MAX_CODES_PER_WINDOW = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;

interface PendingLink {
  /** SHA-256 of the code. The plaintext is shown once and never stored. */
  codeHash: string;
  userId: string;
  expiresAt: number;
}

/**
 * Issues and redeems Telegram linking codes.
 *
 * The point of the flow is that **a user never types a chat id**. A chat id is
 * guessable and unauthenticated — accepting one typed into a form would let
 * anyone route another person's notifications to their own chat, or route their
 * own to someone else's. Instead UltraTorrent issues a short-lived secret, the
 * user proves control of a chat by sending it to the bot, and the backend links
 * the chat that produced it.
 *
 * Codes are held in memory rather than persisted: they live ten minutes, and a
 * restart losing them costs a user one button press. Persisting a credential
 * that short-lived buys nothing and adds a table that must be pruned.
 */
@Injectable()
export class TelegramLinkingService {
  private readonly logger = new Logger(TelegramLinkingService.name);

  /** codeHash → pending link. Keyed by hash so the plaintext is never in memory. */
  private readonly pending = new Map<string, PendingLink>();
  /** userId → issue timestamps inside the current window. */
  private readonly issued = new Map<string, number[]>();
  /**
   * Highest Telegram update id already consumed.
   *
   * Acknowledging past it means a message carrying a code cannot be replayed
   * later to re-link a chat.
   */
  private updateOffset = 0;

  /**
   * Issue a code for one user.
   *
   * Returns the plaintext exactly once — it is stored only as a hash, so a
   * database or memory dump cannot be used to complete somebody's linking.
   */
  issueCode(userId: string): { code: string; expiresInSeconds: number } {
    this.prune();
    this.assertNotRateLimited(userId);

    // Six digits: long enough that guessing inside ten minutes is impractical
    // against a single-use code, short enough to retype on a phone.
    const code = String(randomInt(100_000, 1_000_000));
    const codeHash = this.hash(code);

    // One live code per user — issuing a second invalidates the first, so a
    // code read over someone's shoulder stops working the moment they retry.
    for (const [hash, link] of this.pending) {
      if (link.userId === userId) this.pending.delete(hash);
    }

    this.pending.set(codeHash, { codeHash, userId, expiresAt: Date.now() + CODE_TTL_MS });
    this.recordIssue(userId);

    return { code, expiresInSeconds: Math.floor(CODE_TTL_MS / 1000) };
  }

  /**
   * Find the chat that sent this user's code.
   *
   * Consumes the code on success — single use, so an update replayed or a code
   * shared cannot link a second chat.
   */
  redeem(userId: string, updates: Array<{ updateId: number; chatId: string; text: string; fromUsername: string | null }>):
    { chatId: string; username: string | null } | null {
    this.prune();

    let matched: { chatId: string; username: string | null } | null = null;
    let highestUpdateId = this.updateOffset;

    for (const update of updates) {
      highestUpdateId = Math.max(highestUpdateId, update.updateId);
      // A user may send the code with surrounding text; take the digits.
      const candidate = update.text.trim().match(/\b\d{6}\b/)?.[0];
      if (!candidate) continue;

      const link = this.pending.get(this.hash(candidate));
      if (!link) continue;
      if (link.userId !== userId) continue; // someone else's code — not ours to redeem
      if (link.expiresAt <= Date.now()) continue;

      this.pending.delete(link.codeHash); // single use
      matched = { chatId: update.chatId, username: update.fromUsername };
      // Keep scanning only to advance the offset; the first match wins.
    }

    // Advance past everything seen, so a consumed message cannot be replayed.
    if (highestUpdateId > this.updateOffset) this.updateOffset = highestUpdateId;
    return matched;
  }

  /** The offset to pass to `getUpdates`, acknowledging what we already read. */
  get offset(): number {
    return this.updateOffset > 0 ? this.updateOffset + 1 : 0;
  }

  /** Drop a user's pending code — used when they cancel or disconnect. */
  cancel(userId: string): void {
    for (const [hash, link] of this.pending) {
      if (link.userId === userId) this.pending.delete(hash);
    }
  }

  private assertNotRateLimited(userId: string): void {
    const now = Date.now();
    const recent = (this.issued.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= MAX_CODES_PER_WINDOW) {
      throw new BadRequestException('Too many linking codes requested. Try again in a few minutes.');
    }
    this.issued.set(userId, recent);
  }

  private recordIssue(userId: string): void {
    const list = this.issued.get(userId) ?? [];
    list.push(Date.now());
    this.issued.set(userId, list);
  }

  private prune(): void {
    const now = Date.now();
    for (const [hash, link] of this.pending) {
      if (link.expiresAt <= now) this.pending.delete(hash);
    }
    for (const [userId, times] of this.issued) {
      const recent = times.filter((t) => now - t < RATE_WINDOW_MS);
      if (recent.length) this.issued.set(userId, recent);
      else this.issued.delete(userId);
    }
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
