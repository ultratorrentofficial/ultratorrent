import type { ConnectionBackedChannelType } from '@ultratorrent/shared';
import type { ValidationResult } from './personal-channel.types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `dennis.ayala@gmail.com` → `d•••a@gmail.com`. */
export function maskEmail(address: string): string {
  const [local, domain] = address.split('@');
  if (!local || !domain) return '•••';
  const head = local[0] ?? '';
  const tail = local.length > 1 ? local[local.length - 1] : '';
  return `${head}•••${tail}@${domain}`;
}

/** `+17875551234` → `+1787•••1234`. */
export function maskPhone(phone: string): string {
  if (phone.length <= 8) return '•••';
  return `${phone.slice(0, 5)}•••${phone.slice(-4)}`;
}

/** A Discord webhook URL is a bearer credential — only its shape may be shown. */
export function maskWebhook(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}/…`;
  } catch {
    return '•••';
  }
}

export function maskTelegramChat(chatId: string): string {
  return chatId.length <= 4 ? '•••' : `•••${chatId.slice(-4)}`;
}

/**
 * Hosts a Discord webhook may point at.
 *
 * A webhook URL is fetched by the server, so an unrestricted one is a
 * server-side request forgery primitive: `http://169.254.169.254/…` (cloud
 * metadata), `http://localhost:5432`, or any host on the private network the
 * container can reach. Allow-listing the two real Discord hosts is the only
 * check that cannot be talked around by DNS tricks or redirects, because it is
 * applied to the host the user supplied rather than to what it resolves to.
 */
const DISCORD_WEBHOOK_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];

export function validateDiscordWebhook(url: string): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  // Plain HTTP would send the credential in clear and is never valid for Discord.
  if (u.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  const host = u.hostname.toLowerCase();
  if (!DISCORD_WEBHOOK_HOSTS.includes(host)) return { ok: false, reason: 'host_not_allowed' };
  if (!u.pathname.startsWith('/api/webhooks/')) return { ok: false, reason: 'not_a_webhook_path' };
  return { ok: true };
}

/**
 * Normalize a phone number to E.164.
 *
 * Deliberately strict rather than clever: a number the user typed with spaces or
 * dashes is accepted, but one without a country code is rejected instead of
 * guessed, because guessing a country would silently message a stranger.
 */
export function normalizeE164(input: string): { ok: boolean; phone?: string; reason?: string } {
  const trimmed = input.trim().replace(/[\s()\-.]/g, '');
  if (!trimmed.startsWith('+')) return { ok: false, reason: 'country_code_required' };
  const digits = trimmed.slice(1);
  if (!/^\d{7,15}$/.test(digits)) return { ok: false, reason: 'invalid_length' };
  return { ok: true, phone: `+${digits}` };
}

/**
 * Validate and normalize one connection's config.
 *
 * Returns the config to STORE, which may differ from the input (a phone becomes
 * E.164), plus the display-safe mask — computed once here so listings never need
 * to decrypt anything to render.
 */
export function validatePersonalChannelConfig(
  type: ConnectionBackedChannelType,
  raw: Record<string, unknown>,
): ValidationResult {
  switch (type) {
    case 'email': {
      const address = String(raw.address ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(address)) return { valid: false, reason: 'invalid_email' };
      return { valid: true, config: { address }, destinationMask: maskEmail(address) };
    }
    case 'whatsapp': {
      const r = normalizeE164(String(raw.phone ?? ''));
      if (!r.ok) return { valid: false, reason: r.reason };
      return { valid: true, config: { phone: r.phone! }, destinationMask: maskPhone(r.phone!) };
    }
    case 'discord': {
      const webhookUrl = String(raw.webhookUrl ?? '').trim();
      const r = validateDiscordWebhook(webhookUrl);
      if (!r.ok) return { valid: false, reason: r.reason };
      return { valid: true, config: { webhookUrl }, destinationMask: maskWebhook(webhookUrl) };
    }
    case 'telegram': {
      // A chat id is bound by the linking flow, never accepted from the client:
      // typing someone else's chat id would send them your notifications.
      const chatId = String(raw.chatId ?? '').trim();
      if (!chatId) return { valid: false, reason: 'link_required' };
      return { valid: true, config: { chatId }, destinationMask: maskTelegramChat(chatId) };
    }
    default:
      return { valid: false, reason: 'unsupported_channel_type' };
  }
}

/**
 * The single config field encrypted at rest for each type.
 *
 * Every destination is personal data, and the Discord webhook URL is additionally a
 * bearer credential — so all four are encrypted, not just the obvious secret.
 */
export function secretFieldFor(type: ConnectionBackedChannelType): string | null {
  switch (type) {
    case 'email': return 'address';
    case 'whatsapp': return 'phone';
    case 'discord': return 'webhookUrl';
    case 'telegram': return 'chatId';
    default: return null;
  }
}
