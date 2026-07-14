/**
 * Linking a Trakt account, and keeping its tokens alive.
 *
 * The link is PER USER. A watched state, a rating and a scrobble all belong to a
 * person, not to an installation: two people sharing a server must not write into
 * each other's Trakt history. Everything downstream therefore starts from a user
 * id, never from "the" account.
 *
 * Tokens are encrypted at rest. A Trakt access token is full control of someone's
 * account — it is treated like the TOTP secret, not like an API key — and is never
 * returned by the API or written to a log.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TraktAccount } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../../settings/settings.module';
import { SecretCipher } from '../../../common/crypto/secret-cipher';
import { AuditService } from '../../audit/audit.service';
import type { AuditContext } from '../media-metadata.service';
import { TraktClient, TraktPollError, type DeviceCode, type TraktCredentials } from './trakt-client';

/** Refresh this far before actual expiry rather than discover it mid-sync. */
const REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TraktAuthService {
  private readonly logger = new Logger(TraktAuthService.name);
  /** In-flight device authorizations, by user. Deliberately not persisted: a
   *  pending code is worthless after a restart (it expires in minutes anyway). */
  private readonly pending = new Map<string, DeviceCode>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly cipher: SecretCipher,
    private readonly audit: AuditService,
  ) {}

  /** The Trakt application's own credentials (the operator registers the app). */
  async credentials(): Promise<TraktCredentials | null> {
    const clientId =
      (await this.settings.get<string>('media.trakt.clientId')) ?? process.env.TRAKT_CLIENT_ID;
    const clientSecret =
      (await this.settings.get<string>('media.trakt.clientSecret')) ??
      process.env.TRAKT_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  private async client(): Promise<TraktClient> {
    const creds = await this.credentials();
    if (!creds) {
      throw new BadRequestException(
        'Trakt is not configured — save the application Client ID and Secret first.',
      );
    }
    return new TraktClient(creds);
  }

  /**
   * Begin the device flow: returns the code the operator types at
   * trakt.tv/activate. Nothing is stored until they approve it.
   */
  async startDeviceAuth(userId: string): Promise<DeviceCode> {
    const client = await this.client();
    let code: DeviceCode;
    try {
      code = await client.requestDeviceCode();
    } catch (err) {
      // A bad client id is an OPERATOR error (a mistyped credential), not a server
      // fault. Surfaced as a 400 carrying Trakt's own reason — a bare 500
      // "Internal server error" tells the person who typed the key nothing.
      throw new BadRequestException((err as Error).message);
    }
    this.pending.set(userId, code);
    return code;
  }

  /**
   * One poll of the pending authorization for this user.
   *
   * Returns the link once approved, or a status telling the caller what to do:
   * `pending` → keep waiting; `slow_down` → wait longer; anything else is
   * terminal and clears the attempt. The distinction matters — Trakt throttles
   * applications that poll through a `slow_down`.
   */
  async pollDeviceAuth(
    userId: string,
    ctx: AuditContext = {},
  ): Promise<
    | { status: 'authorized'; username?: string | null }
    | { status: 'pending' | 'slow_down' }
    | { status: 'expired' | 'denied' | 'used' | 'not_found' }
  > {
    const code = this.pending.get(userId);
    if (!code) throw new BadRequestException('No Trakt authorization is in progress.');

    const client = await this.client();
    try {
      const tokens = await client.pollDeviceToken(code.deviceCode);
      const me = await client.me(tokens.accessToken).catch(() => ({ username: undefined, slug: undefined }));

      await this.prisma.traktAccount.upsert({
        where: { userId },
        create: {
          userId,
          username: me.username ?? null,
          slug: me.slug ?? null,
          accessToken: this.cipher.encrypt(tokens.accessToken),
          refreshToken: this.cipher.encrypt(tokens.refreshToken),
          expiresAt: tokens.expiresAt,
          scope: tokens.scope ?? null,
        },
        update: {
          username: me.username ?? null,
          slug: me.slug ?? null,
          accessToken: this.cipher.encrypt(tokens.accessToken),
          refreshToken: this.cipher.encrypt(tokens.refreshToken),
          expiresAt: tokens.expiresAt,
          scope: tokens.scope ?? null,
          lastError: null,
        },
      });
      this.pending.delete(userId);

      await this.audit.record({
        userId: ctx.userId ?? userId,
        action: 'media.trakt.linked',
        objectType: 'trakt_account',
        objectId: userId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        // The Trakt username, never a token.
        metadata: { traktUsername: me.username ?? null },
      });

      return { status: 'authorized', username: me.username ?? null };
    } catch (err) {
      if (err instanceof TraktPollError) {
        if (err.status === 'pending' || err.status === 'slow_down') return { status: err.status };
        this.pending.delete(userId); // terminal — do not keep polling a dead code
        return { status: err.status };
      }
      throw err;
    }
  }

  /** The linked account, or null. Tokens stay encrypted — see {@link accessTokenFor}. */
  async account(userId: string): Promise<TraktAccount | null> {
    return this.prisma.traktAccount.findUnique({ where: { userId } });
  }

  /**
   * A usable access token for this user, refreshing it if it is close to expiry.
   *
   * Refreshes a day early rather than let a long sync die halfway through on a
   * token that expired between its first and last request.
   */
  async accessTokenFor(userId: string): Promise<string> {
    const account = await this.prisma.traktAccount.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('No Trakt account is linked.');

    if (account.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
      return this.cipher.decrypt(account.accessToken);
    }

    const client = await this.client();
    try {
      const tokens = await client.refresh(this.cipher.decrypt(account.refreshToken));
      await this.prisma.traktAccount.update({
        where: { userId },
        data: {
          accessToken: this.cipher.encrypt(tokens.accessToken),
          refreshToken: this.cipher.encrypt(tokens.refreshToken),
          expiresAt: tokens.expiresAt,
          lastError: null,
        },
      });
      return tokens.accessToken;
    } catch (err) {
      // A dead refresh token means the link is gone (revoked, or the app's
      // secret changed). Record WHY, so the UI can say "reconnect" rather than
      // failing every sync in silence forever.
      await this.prisma.traktAccount.update({
        where: { userId },
        data: { lastError: `Token refresh failed: ${(err as Error).message}` },
      });
      throw err;
    }
  }

  /** Which sync directions this account opted into. */
  async updateSettings(
    userId: string,
    patch: Partial<
      Pick<
        TraktAccount,
        | 'syncCollection'
        | 'syncWatched'
        | 'syncRatings'
        | 'syncWatchlist'
        | 'scrobbleEnabled'
        | 'mediaServerUserName'
      >
    >,
  ): Promise<TraktAccount> {
    const account = await this.prisma.traktAccount.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('No Trakt account is linked.');
    return this.prisma.traktAccount.update({ where: { userId }, data: patch });
  }

  /** Unlink. The tokens are deleted, not just forgotten. */
  async disconnect(userId: string, ctx: AuditContext = {}): Promise<void> {
    const account = await this.prisma.traktAccount.findUnique({ where: { userId } });
    if (!account) return;
    await this.prisma.traktAccount.delete({ where: { userId } });
    this.pending.delete(userId);
    await this.audit.record({
      userId: ctx.userId ?? userId,
      action: 'media.trakt.unlinked',
      objectType: 'trakt_account',
      objectId: userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { traktUsername: account.username },
    });
  }

  /** Status for the UI. Never includes a token. */
  async status(userId: string): Promise<{
    configured: boolean;
    linked: boolean;
    username?: string | null;
    expiresAt?: Date | null;
    lastError?: string | null;
    settings?: {
      syncCollection: boolean;
      syncWatched: boolean;
      syncRatings: boolean;
      syncWatchlist: boolean;
      scrobbleEnabled: boolean;
      mediaServerUserName: string | null;
    };
    lastSync?: {
      collection: Date | null;
      watched: Date | null;
      ratings: Date | null;
      watchlist: Date | null;
    };
  }> {
    const configured = (await this.credentials()) !== null;
    const account = await this.prisma.traktAccount.findUnique({ where: { userId } });
    if (!account) return { configured, linked: false };
    return {
      configured,
      linked: true,
      username: account.username,
      expiresAt: account.expiresAt,
      lastError: account.lastError,
      settings: {
        syncCollection: account.syncCollection,
        syncWatched: account.syncWatched,
        syncRatings: account.syncRatings,
        syncWatchlist: account.syncWatchlist,
        scrobbleEnabled: account.scrobbleEnabled,
        mediaServerUserName: account.mediaServerUserName,
      },
      lastSync: {
        collection: account.lastCollectionSyncAt,
        watched: account.lastWatchedSyncAt,
        ratings: account.lastRatingsSyncAt,
        watchlist: account.lastWatchlistSyncAt,
      },
    };
  }
}
