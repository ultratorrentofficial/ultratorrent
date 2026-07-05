import { BadRequestException, Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';

const EMAIL_KEY = 'media_server_analytics.email';

interface EmailConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  encryptedPass?: string;
  fromName?: string;
  fromAddress?: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * SMTP email delivery for newsletters. Config lives in the `Setting` store with
 * the password AES-256-GCM encrypted; it is never returned or logged.
 */
@Injectable()
export class MediaServerEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
  ) {}

  /** Redacted settings (never returns the password). */
  async getSettings() {
    const cfg = await this.raw();
    return {
      host: cfg.host ?? '',
      port: cfg.port ?? 587,
      secure: cfg.secure ?? false,
      user: cfg.user ?? '',
      fromName: cfg.fromName ?? 'UltraTorrent',
      fromAddress: cfg.fromAddress ?? '',
      hasPassword: Boolean(cfg.encryptedPass),
    };
  }

  async updateSettings(input: {
    host?: string; port?: number; secure?: boolean; user?: string;
    password?: string; fromName?: string; fromAddress?: string;
  }) {
    const cur = await this.raw();
    const next: EmailConfig = {
      ...cur,
      host: input.host ?? cur.host,
      port: input.port ?? cur.port,
      secure: input.secure ?? cur.secure,
      user: input.user ?? cur.user,
      fromName: input.fromName ?? cur.fromName,
      fromAddress: input.fromAddress ?? cur.fromAddress,
    };
    // A blank / redaction-marker password means "keep existing".
    if (input.password && !/^•+$/.test(input.password)) next.encryptedPass = this.cipher.encrypt(input.password);
    await this.prisma.setting.upsert({
      where: { key: EMAIL_KEY },
      create: { key: EMAIL_KEY, value: next as object },
      update: { value: next as object },
    });
    return this.getSettings();
  }

  async isConfigured(): Promise<boolean> {
    const cfg = await this.raw();
    return Boolean(cfg.host && cfg.fromAddress);
  }

  async send(email: OutgoingEmail): Promise<void> {
    const cfg = await this.raw();
    if (!cfg.host || !cfg.fromAddress) throw new BadRequestException('Email is not configured.');
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port ?? 587,
      secure: cfg.secure ?? false,
      auth: cfg.user ? { user: cfg.user, pass: cfg.encryptedPass ? this.cipher.decrypt(cfg.encryptedPass) : '' } : undefined,
    });
    await transport.sendMail({
      from: `"${cfg.fromName ?? 'UltraTorrent'}" <${cfg.fromAddress}>`,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  }

  async testEmail(to: string): Promise<{ ok: boolean }> {
    await this.send({
      to,
      subject: 'UltraTorrent — SMTP test',
      html: '<p>Your UltraTorrent email settings are working. 🎉</p>',
      text: 'Your UltraTorrent email settings are working.',
    });
    return { ok: true };
  }

  private async raw(): Promise<EmailConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: EMAIL_KEY } });
    return (row?.value as EmailConfig) ?? {};
  }
}
