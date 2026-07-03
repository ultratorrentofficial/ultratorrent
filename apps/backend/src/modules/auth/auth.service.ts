import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthUser, LoginResponse } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TwoFactorService } from '../two-factor/two-factor.service';

interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

/** Thrown when a password is correct but a TOTP code is still required. */
export class TwoFactorRequiredException extends UnauthorizedException {
  constructor() {
    super({
      statusCode: 401,
      error: 'TwoFactorRequired',
      message: 'Two-factor authentication code required',
      twoFactorRequired: true,
    });
  }
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Load a user with flattened role names and permission keys. */
  private async loadAuthUser(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        roles: {
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        },
      },
    });
    const roles = user.roles.map((ur) => ur.role.name);
    const permissions = [
      ...new Set(
        user.roles.flatMap((ur) =>
          ur.role.permissions.map((rp) => rp.permission.key),
        ),
      ),
    ];
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      roles,
      permissions,
      isActive: user.isActive,
    };
  }

  private async issueTokens(
    authUser: AuthUser,
    ctx: RequestContext,
    family?: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const accessToken = await this.jwt.signAsync(
      {
        sub: authUser.id,
        username: authUser.username,
        roles: authUser.roles,
        permissions: authUser.permissions,
        type: 'access',
      },
      {
        secret: this.config.get<string>('jwt.accessSecret'),
        expiresIn: this.config.get<string>('jwt.accessTtl'),
      },
    );

    const refreshRaw = randomBytes(48).toString('base64url');
    const tokenFamily = family ?? randomUUID();
    const ttlDays = this.config.get<number>('jwt.refreshTtlDays')!;
    const expiresAt = new Date(Date.now() + ttlDays * 86400_000);

    await this.prisma.refreshToken.create({
      data: {
        userId: authUser.id,
        tokenHash: this.hashToken(refreshRaw),
        family: tokenFamily,
        userAgent: ctx.userAgent,
        ipAddress: ctx.ipAddress,
        expiresAt,
      },
    });

    // Refresh token carries its family so rotation can be tracked.
    const refreshToken = `${tokenFamily}.${refreshRaw}`;
    return { accessToken, refreshToken, expiresIn: 15 * 60 };
  }

  async login(
    username: string,
    password: string,
    ctx: RequestContext,
    totp?: string,
  ): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({ where: { username } });
    // Constant-ish work factor whether or not the user exists.
    const hash =
      user?.passwordHash ??
      '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid = await argon2.verify(hash, password).catch(() => false);
    if (!user || !valid || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Second factor: only after the password is confirmed correct.
    if (user.totpEnabled) {
      if (!totp) throw new TwoFactorRequiredException();
      const ok = await this.twoFactor.verifyForLogin(user, totp);
      if (!ok) throw new UnauthorizedException('Invalid two-factor code');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const authUser = await this.loadAuthUser(user.id);
    const tokens = await this.issueTokens(authUser, ctx);
    return { ...tokens, user: authUser };
  }

  async refresh(rawToken: string, ctx: RequestContext) {
    const [family, secret] = rawToken.split('.');
    if (!family || !secret) {
      throw new UnauthorizedException('Malformed refresh token');
    }
    const tokenHash = this.hashToken(secret);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!stored || stored.family !== family) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (stored.revokedAt) {
      // Reuse of a rotated token → compromise. Burn the whole family.
      await this.prisma.refreshToken.updateMany({
        where: { family, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Rotate: revoke current, issue a new one in the same family.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const authUser = await this.loadAuthUser(stored.userId);
    // A deactivated/offboarded account must not be able to mint new tokens.
    if (!authUser.isActive) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Account is disabled');
    }
    const tokens = await this.issueTokens(authUser, ctx, family);
    return { ...tokens, user: authUser };
  }

  async logout(rawToken: string): Promise<void> {
    const [family, secret] = rawToken.split('.');
    if (!secret) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(secret), family },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<AuthUser> {
    return this.loadAuthUser(userId);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) throw new BadRequestException('Current password is incorrect');
    const passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    // Invalidate all sessions on password change.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
