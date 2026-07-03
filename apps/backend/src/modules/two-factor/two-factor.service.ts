import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
    private readonly config: ConfigService,
  ) {
    // Tolerate ±1 time-step (30s) of clock skew.
    authenticator.options = { window: 1 };
  }

  async status(userId: string): Promise<{ enabled: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpEnabled: true },
    });
    return { enabled: user.totpEnabled };
  }

  /** Generate a fresh secret and store it (pending) until the user confirms. */
  async setup(userId: string): Promise<TwoFactorSetup> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.totpEnabled) {
      throw new BadRequestException('Two-factor is already enabled');
    }
    const issuer =
      (await this.config.get<string>('general.productName')) ?? 'UltraTorrent';
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.username, issuer, secret);

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: this.cipher.encrypt(secret) },
    });

    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    return { secret, otpauthUrl, qrDataUrl };
  }

  /** Confirm the pending secret with a code, enable 2FA, return recovery codes. */
  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.totpEnabled) {
      throw new BadRequestException('Two-factor is already enabled');
    }
    if (!user.totpSecret) {
      throw new BadRequestException('Start setup before enabling two-factor');
    }
    const secret = this.cipher.decrypt(user.totpSecret);
    if (!authenticator.verify({ token: code.trim(), secret })) {
      throw new BadRequestException('Invalid verification code');
    }

    const recoveryCodes = this.generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpEnabled: true,
        recoveryCodes: recoveryCodes.map((c) => this.hashCode(c)),
      },
    });
    return { recoveryCodes };
  }

  /** Disable 2FA — requires the account password as confirmation. */
  async disable(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) throw new UnauthorizedException('Incorrect password');
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecret: null, recoveryCodes: [] },
    });
  }

  /** Regenerate recovery codes — requires a current TOTP code. */
  async regenerateRecoveryCodes(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException('Two-factor is not enabled');
    }
    const secret = this.cipher.decrypt(user.totpSecret);
    if (!authenticator.verify({ token: code.trim(), secret })) {
      throw new BadRequestException('Invalid verification code');
    }
    const recoveryCodes = this.generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: { recoveryCodes: recoveryCodes.map((c) => this.hashCode(c)) },
    });
    return { recoveryCodes };
  }

  /**
   * Verify a login challenge: a TOTP token, or a one-time recovery code (which
   * is consumed on use). Returns true when 2FA passes (or isn't enabled).
   */
  async verifyForLogin(user: User, token: string): Promise<boolean> {
    if (!user.totpEnabled || !user.totpSecret) return true;
    const trimmed = token.trim();

    const secret = this.cipher.decrypt(user.totpSecret);
    if (authenticator.verify({ token: trimmed, secret })) return true;

    // Fall back to recovery codes.
    const hashed = this.hashCode(trimmed);
    if (user.recoveryCodes.includes(hashed)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { recoveryCodes: user.recoveryCodes.filter((c) => c !== hashed) },
      });
      return true;
    }
    return false;
  }

  private generateRecoveryCodes(count = 10): string[] {
    return Array.from({ length: count }, () => {
      // 80 bits of entropy (was 40) so a DB leak can't be brute-forced offline.
      const raw = randomBytes(10).toString('hex'); // 20 hex chars
      return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`;
    });
  }

  private hashCode(code: string): string {
    const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
    return createHash('sha256').update(normalized).digest('hex');
  }
}
