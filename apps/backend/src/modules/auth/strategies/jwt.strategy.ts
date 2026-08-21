import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';

export interface JwtPayload {
  sub: string;
  username: string;
  roles: string[];
  permissions: string[];
  type: 'access';
}

/**
 * Short window a re-validated identity is cached, so we don't hit the DB on every
 * request. A deleted/deactivated user, a removed role, or a revoked permission takes
 * effect within this window instead of only at access-token expiry.
 */
const REVALIDATE_TTL_MS = 15_000;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);
  private cache = new Map<string, { at: number; user: AuthenticatedUser | null }>();
  /**
   * Whether revalidation is currently degraded, and how many requests were
   * admitted on token claims while it has been.
   *
   * Kept as state so the warning fires on the TRANSITION rather than per
   * request: this path runs on every authenticated call, and a busy instance
   * would bury the log it is meant to draw attention to.
   */
  private degraded = false;
  private admittedWhileDegraded = 0;
  /** Fail CLOSED on a database error instead of trusting the token's claims. */
  private readonly failClosed: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret')!,
      // Pin the algorithm so a token can't be presented under a different alg.
      algorithms: ['HS256'],
    });
    /*
     * Default is fail-OPEN, which suits a self-hosted instance: during a
     * database outage the torrent list, engine status and system pages still
     * work — they read from the engine, not Postgres — and that is exactly when
     * an operator needs to get in. A deployment with a different threat model
     * (multi-user, internet-exposed) can invert it rather than patch it.
     */
    this.failClosed = String(process.env.AUTH_FAIL_CLOSED ?? '').toLowerCase() === 'true';
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }
    // Re-validate against the DB rather than trusting the token claims for the full
    // 15-minute TTL: previously a deleted/deactivated user kept access, and revoked
    // permissions / removed roles stayed in force, until the token expired.
    const current = await this.currentIdentity(payload.sub);
    if (current === undefined) {
      /*
       * DB unreachable — fall back to the (validly-signed, unexpired) token
       * claims. Not a bypass: the token still had to be signed by us and be
       * unexpired, so this is the posture the app had before revalidation
       * existed. It widens the revocation window from ~15 seconds back to the
       * token's remaining TTL, in BOTH directions — a permission granted during
       * the outage does not take effect either, because the claims are frozen.
       */
      if (this.failClosed) {
        throw new UnauthorizedException('Cannot verify the account right now');
      }
      this.enterDegraded();
      return {
        id: payload.sub,
        username: payload.username,
        roles: payload.roles ?? [],
        permissions: payload.permissions ?? [],
      };
    }
    // A definitive answer means revalidation is working again.
    this.leaveDegraded();
    if (current === null) {
      // Definitive: the user is gone or deactivated. Fail closed.
      throw new UnauthorizedException('Account is no longer active');
    }
    return current;
  }

  /** First admission on stale claims in this outage: say so, once. */
  private enterDegraded(): void {
    this.admittedWhileDegraded += 1;
    if (this.degraded) return;
    this.degraded = true;
    this.logger.warn(
      'Account revalidation is DEGRADED — the database is unreachable, so requests are being ' +
        'admitted on their token claims. A revoked account keeps access until its token expires.',
    );
  }

  /** Back to normal: report how much was admitted, so the gap is answerable. */
  private leaveDegraded(): void {
    if (!this.degraded) return;
    this.degraded = false;
    const admitted = this.admittedWhileDegraded;
    this.admittedWhileDegraded = 0;
    this.logger.warn(
      `Account revalidation recovered — ${admitted} request(s) were admitted on token claims ` +
        'while the database was unreachable.',
    );
    /*
     * Recorded on RECOVERY, not on entry: the audit log lives in the database
     * that was unreachable, so the only moment this can be written is once it
     * is back. That is what turns "was anyone acting on stale permissions
     * during the outage?" from unanswerable into a query.
     */
    void this.audit.record({
      action: 'auth.revalidation_degraded',
      objectType: 'system',
      result: 'success',
      metadata: { admittedRequests: admitted },
    });
  }

  /**
   * The user's current identity + freshly-derived permissions, cached for
   * {@link REVALIDATE_TTL_MS}. Returns `null` when the user is missing/inactive
   * (definitive reject) and `undefined` on a DB error (caller should fail open).
   */
  private async currentIdentity(userId: string): Promise<AuthenticatedUser | null | undefined> {
    const now = Date.now();
    const hit = this.cache.get(userId);
    if (hit && now - hit.at < REVALIDATE_TTL_MS) return hit.user;

    let user;
    try {
      user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
        },
      });
    } catch {
      return undefined; // DB error — do not lock everyone out on a transient blip.
    }

    const resolved: AuthenticatedUser | null =
      user && user.isActive
        ? {
            id: user.id,
            username: user.username,
            roles: user.roles.map((ur) => ur.role.name),
            permissions: [
              ...new Set(user.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.key))),
            ],
          }
        : null;

    // Bound the cache for very long-lived processes (self-hosted → few users, but
    // never grow without limit).
    if (this.cache.size > 1000) this.cache.clear();
    this.cache.set(userId, { at: now, user: resolved });
    return resolved;
  }
}
