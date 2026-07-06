import * as nodemailer from 'nodemailer';
import {
  BaseNotificationProvider,
  escapeHtml,
  cardToText,
  type ConfigValidation,
  type HealthResult,
  type NotificationAddress,
  type NotificationCapabilities,
  type NotificationCard,
  type NotificationKind,
  type NotificationMessage,
  type NotificationProviderConfig,
  type SendResult,
} from '../notification-provider';

interface EmailConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: boolean;
  user?: string;
  pass?: string; // decrypted at call time
  fromName?: string;
  fromAddress?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Responsive HTML email with an inline rich card. */
export function renderEmailHtml(msg: NotificationMessage, brand = 'UltraTorrent'): string {
  const c = msg.card;
  const badge = (t: string) =>
    `<span style="display:inline-block;background:#23232f;color:#c9c9d4;font:600 11px system-ui;padding:2px 8px;border-radius:6px;margin:0 4px 4px 0">${escapeHtml(t)}</span>`;
  const badges = [
    ...(c.badges ?? []),
    ...(c.rating != null && c.rating > 0 ? [`★ ${c.rating.toFixed(1)}`] : []),
  ].map(badge).join('');
  const button = (label: string, url: string) =>
    `<a href="${escapeHtml(url)}" style="display:inline-block;background:#f5a623;color:#141414;font:700 13px system-ui;text-decoration:none;padding:8px 16px;border-radius:8px;margin:4px 8px 0 0">${escapeHtml(label)}</a>`;
  const buttons = (c.buttons ?? []).map((b) => button(b.label, b.url)).join('');
  const poster = c.posterUrl
    ? `<td valign="top" width="96" style="width:96px;padding-right:14px"><img src="${escapeHtml(c.posterUrl)}" width="96" alt="" style="display:block;width:96px;max-width:100%;height:auto;border-radius:8px;border:1px solid #2a2a3a"/></td>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="dark"/></head>
<body bgcolor="#0b0b12" style="margin:0;padding:0;background-color:#0b0b12">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0b0b12" style="background-color:#0b0b12"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="#15151f" style="width:600px;max-width:100%;background-color:#15151f;border:1px solid #26263a;border-radius:14px;overflow:hidden">
      <tr><td style="padding:18px 20px 6px;font:800 13px system-ui;letter-spacing:.08em;color:#f5a623">${escapeHtml(brand.toUpperCase())}</td></tr>
      <tr><td style="padding:6px 20px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${poster}
        <td valign="top">
          <div style="font:700 18px system-ui;color:#f4f4f8">${escapeHtml(c.title)}</div>
          ${c.subtitle ? `<div style="font:600 13px system-ui;color:#9a9aa8;margin-top:2px">${escapeHtml(c.subtitle)}</div>` : ''}
          ${badges ? `<div style="margin-top:8px">${badges}</div>` : ''}
          ${c.overview ? `<div style="font:400 13px/1.5 system-ui;color:#c9c9d4;margin-top:8px">${escapeHtml(c.overview)}</div>` : ''}
          ${buttons ? `<div style="margin-top:12px">${buttons}</div>` : ''}
        </td>
      </tr></table></td></tr>
      ${c.footer ? `<tr><td style="padding:0 20px 18px;font:400 11px system-ui;color:#6b6b7a">${escapeHtml(c.footer)}</td></tr>` : ''}
    </table>
  </td></tr></table>
</body></html>`;
}

/** Delivers notifications over SMTP with a rich HTML card + plain-text fallback. */
export class EmailNotificationProvider extends BaseNotificationProvider {
  readonly kind: NotificationKind = 'email';

  capabilities(): NotificationCapabilities {
    return {
      richCards: true, images: true, buttons: true, markdown: false, attachments: true,
      scheduling: false, priority: true, readReceipts: false, templates: true, media: true,
      typingIndicators: false, threads: false, reactions: false,
    };
  }

  validateConfiguration(config: NotificationProviderConfig): ConfigValidation {
    const c = config as EmailConfig;
    const errors: string[] = [];
    if (!c.host) errors.push('host is required');
    if (!c.fromAddress) errors.push('fromAddress is required');
    return { ok: errors.length === 0, errors };
  }

  validateRecipient(addr: NotificationAddress): boolean {
    return !!addr.email && EMAIL_RE.test(addr.email);
  }

  normalizeRecipient(addr: NotificationAddress): string | null {
    return addr.email ? addr.email.trim().toLowerCase() : null;
  }

  private transport(c: EmailConfig) {
    return nodemailer.createTransport({
      host: c.host,
      port: c.port ?? 587,
      secure: c.secure ?? false,
      auth: (c.auth ?? Boolean(c.user)) ? { user: c.user ?? '', pass: c.pass ?? '' } : undefined,
    });
  }

  async testConnection(config: NotificationProviderConfig): Promise<HealthResult> {
    const c = config as EmailConfig;
    if (!c.host) return { ok: false, status: 'offline', error: 'host not configured' };
    try {
      await this.transport(c).verify();
      return { ok: true, status: 'online' };
    } catch (e) {
      return { ok: false, status: 'offline', error: e instanceof Error ? e.message : String(e) };
    }
  }

  async send(config: NotificationProviderConfig, addr: NotificationAddress, msg: NotificationMessage): Promise<SendResult> {
    const c = config as EmailConfig;
    const to = this.normalizeRecipient(addr);
    if (!to) return { ok: false, error: 'invalid email recipient' };
    try {
      const info = await this.transport(c).sendMail({
        from: `"${c.fromName ?? 'UltraTorrent'}" <${c.fromAddress}>`,
        to,
        subject: msg.subject ?? msg.card.title,
        text: msg.text || cardToText(msg.card),
        html: msg.html ?? renderEmailHtml(msg),
      });
      return { ok: true, providerMessageId: info.messageId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export type { NotificationCard };
