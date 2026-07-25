import { BadRequestException, Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';

/**
 * The setting key the SMTP config has always lived under.
 *
 * Deliberately kept, despite now serving the whole platform rather than just
 * newsletters: renaming it would orphan the working configuration on every
 * existing install for the sake of tidiness. The name is historical; the scope
 * is platform-wide.
 */
const EMAIL_KEY = 'media_server_analytics.email';

interface EmailConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  /** Whether to send SMTP AUTH at all — some relays reject it outright. */
  auth?: boolean;
  user?: string;
  encryptedPass?: string;
  fromName?: string;
  fromAddress?: string;
}

/** An inline image referenced from HTML via `cid:<cid>`. */
export interface EmailAttachment {
  cid: string;
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface MailSettings {
  host: string;
  port: number;
  secure: boolean;
  auth: boolean;
  user: string;
  fromName: string;
  fromAddress: string;
  hasPassword: boolean;
}

/**
 * The platform's single outbound SMTP transport.
 *
 * **One transport, many destinations.** The relay is infrastructure an operator
 * configures once; the address each message goes to is per-user. That separation
 * is what lets personal notification email work without asking every user for
 * SMTP credentials — nobody supplies a secret, so there is no per-user secret to
 * leak.
 *
 * Extracted from the newsletter module, which owned it when newsletters were the
 * only sender. It is the same config and the same setting key — a second SMTP
 * configuration would be two things to keep working and two places to get wrong.
 *
 * The password is AES-256-GCM encrypted at rest and never returned or logged.
 */
@Injectable()
export class MailTransportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
  ) {}

  /** Settings for display — never includes the password. */
  async getSettings(): Promise<MailSettings> {
    const cfg = await this.raw();
    return {
      host: cfg.host ?? '',
      port: cfg.port ?? 587,
      secure: cfg.secure ?? false,
      // Back-compat: older configs enabled auth implicitly via a username.
      auth: cfg.auth ?? Boolean(cfg.user),
      user: cfg.user ?? '',
      fromName: cfg.fromName ?? 'UltraTorrent',
      fromAddress: cfg.fromAddress ?? '',
      hasPassword: Boolean(cfg.encryptedPass),
    };
  }

  async updateSettings(input: {
    host?: string; port?: number; secure?: boolean; auth?: boolean; user?: string;
    password?: string; fromName?: string; fromAddress?: string;
  }): Promise<MailSettings> {
    const cur = await this.raw();
    const next: EmailConfig = {
      ...cur,
      host: input.host ?? cur.host,
      port: input.port ?? cur.port,
      secure: input.secure ?? cur.secure,
      auth: input.auth ?? cur.auth,
      user: input.user ?? cur.user,
      fromName: input.fromName ?? cur.fromName,
      fromAddress: input.fromAddress ?? cur.fromAddress,
    };
    // A blank or all-bullets value means "keep the existing password", so the UI
    // can round-trip its own redaction without wiping the secret.
    if (input.password && !/^•+$/.test(input.password)) {
      next.encryptedPass = this.cipher.encrypt(input.password);
    }
    await this.prisma.setting.upsert({
      where: { key: EMAIL_KEY },
      create: { key: EMAIL_KEY, value: next as object },
      update: { value: next as object },
    });
    return this.getSettings();
  }

  /** Whether the platform can send at all. Consulted before offering email. */
  async isConfigured(): Promise<boolean> {
    const cfg = await this.raw();
    return Boolean(cfg.host && cfg.fromAddress);
  }

  async send(email: OutgoingEmail): Promise<void> {
    const cfg = await this.raw();
    if (!cfg.host || !cfg.fromAddress) throw new BadRequestException('Email is not configured.');
    const useAuth = cfg.auth ?? Boolean(cfg.user);
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port ?? 587,
      secure: cfg.secure ?? false,
      auth: useAuth
        ? { user: cfg.user ?? '', pass: cfg.encryptedPass ? this.cipher.decrypt(cfg.encryptedPass) : '' }
        : undefined,
    });
    await transport.sendMail({
      from: `"${cfg.fromName ?? 'UltraTorrent'}" <${cfg.fromAddress}>`,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: email.attachments?.map((a) => ({
        cid: a.cid,
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
  }

  private async raw(): Promise<EmailConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: EMAIL_KEY } });
    return (row?.value as EmailConfig) ?? {};
  }
}
