import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

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
  private cache = new Map<string, { at: number; user: AuthenticatedUser | null }>();

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret')!,
      // Pin the algorithm so a token can't be presented under a different alg.
      algorithms: ['HS256'],
    });
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
      // DB unreachable — fail OPEN to the (validly-signed, unexpired) token claims.
      // Availability wins over the 15-second revocation tightening; the token is
      // still cryptographically valid, so this is no worse than the prior behaviour.
      return {
        id: payload.sub,
        username: payload.username,
        roles: payload.roles ?? [],
        permissions: payload.permissions ?? [],
      };
    }
    if (current === null) {
      // Definitive: the user is gone or deactivated. Fail closed.
      throw new UnauthorizedException('Account is no longer active');
    }
    return current;
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
