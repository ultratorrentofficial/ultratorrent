/**
 * Provider abstraction for the Notification Center. Business logic (rules,
 * delivery queue, templates) NEVER references a provider's API directly — it
 * only speaks this interface. Adding a new channel (Discord, Slack, ntfy, FCM…)
 * is a new class + a `getNotificationProvider()` entry, nothing else.
 *
 * Mirrors the shape of `media/media-server-provider.ts`: a kind union, a
 * decrypted config passed at call time, a declared capability set, and a plain
 * factory. Pure/dependency-light so the pieces are unit-testable.
 */

export type NotificationKind =
  | 'email'
  | 'sms'
  | 'telegram'
  | 'whatsapp'
  // future — each is just a class + factory entry:
  | 'discord'
  | 'slack'
  | 'teams'
  | 'signal'
  | 'matrix'
  | 'ntfy'
  | 'gotify'
  | 'pushover'
  | 'webhook';

/** Everything a provider can (or can't) render. Drives the `supports*()` API. */
export interface NotificationCapabilities {
  richCards: boolean;
  images: boolean;
  buttons: boolean;
  markdown: boolean;
  attachments: boolean;
  scheduling: boolean;
  priority: boolean;
  readReceipts: boolean;
  templates: boolean;
  media: boolean;
  typingIndicators: boolean;
  threads: boolean;
  reactions: boolean;
}

export const NO_CAPABILITIES: NotificationCapabilities = {
  richCards: false, images: false, buttons: false, markdown: false, attachments: false,
  scheduling: false, priority: false, readReceipts: false, templates: false, media: false,
  typingIndicators: false, threads: false, reactions: false,
};

export interface NotificationButton {
  label: string;
  url: string;
}

/** Provider-agnostic rich media card. Each provider renders it to its own level. */
export interface NotificationCard {
  title: string;
  subtitle?: string | null;
  /**
   * Who the event is about — the actor named by the *event payload*, never the
   * recipient. A playback card that cannot say who is watching is useless, and
   * naming the recipient instead would be an outright lie on any event (a CPU
   * alert is not "caused by" whoever it was mailed to).
   */
  actor?: string | null;
  /** What happened, in the admin's own words (the rule name). */
  action?: string | null;
  overview?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  badges?: string[];
  rating?: number | null;
  genres?: string[];
  runtime?: number | null;
  buttons?: NotificationButton[];
  footer?: string | null;
  timestamp?: string | null;
}

export interface NotificationAttachmentRef {
  filename: string;
  url?: string | null;
  contentType?: string | null;
}

export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

/** A fully-rendered message handed to a provider. `text` is always present. */
export interface NotificationMessage {
  subject?: string | null;
  card: NotificationCard;
  text: string;
  html?: string | null;
  markdown?: string | null;
  priority?: NotificationPriority;
  attachments?: NotificationAttachmentRef[];
}

/** A recipient's contact details; providers pick the field they use. */
export interface NotificationAddress {
  email?: string | null;
  phone?: string | null;
  telegramChatId?: string | null;
  whatsappNumber?: string | null;
  raw?: string | null;
}

/** Decrypted, provider-specific config (from the channel's `config`). */
export type NotificationProviderConfig = Record<string, unknown>;

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface HealthResult {
  ok: boolean;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  error?: string;
}

export interface ConfigValidation {
  ok: boolean;
  errors: string[];
}

export interface NotificationProvider {
  readonly kind: NotificationKind;
  capabilities(): NotificationCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  testConnection(config: NotificationProviderConfig): Promise<HealthResult>;
  healthCheck(config: NotificationProviderConfig): Promise<HealthResult>;
  validateConfiguration(config: NotificationProviderConfig): ConfigValidation;
  validateRecipient(addr: NotificationAddress): boolean;
  normalizeRecipient(addr: NotificationAddress): string | null;
  send(config: NotificationProviderConfig, addr: NotificationAddress, msg: NotificationMessage): Promise<SendResult>;
  sendTemplate(config: NotificationProviderConfig, addr: NotificationAddress, msg: NotificationMessage): Promise<SendResult>;
  sendBulk(config: NotificationProviderConfig, addrs: NotificationAddress[], msg: NotificationMessage): Promise<SendResult[]>;
  cancel(providerMessageId: string): Promise<boolean>;
  getStatus(providerMessageId: string): Promise<string>;
  supportsRichCards(): boolean;
  supportsImages(): boolean;
  supportsButtons(): boolean;
  supportsMarkdown(): boolean;
  supportsAttachments(): boolean;
  supportsScheduling(): boolean;
  supportsPriority(): boolean;
  supportsReadReceipts(): boolean;
  supportsTemplates(): boolean;
  supportsMedia(): boolean;
  supportsTypingIndicators(): boolean;
  supportsThreads(): boolean;
  supportsReactions(): boolean;
}

/**
 * Sensible defaults so each concrete provider only implements what's distinct:
 * `kind`, `capabilities`, `validateRecipient`, `normalizeRecipient`, `send`,
 * `testConnection`. Everything else derives from those.
 */
export abstract class BaseNotificationProvider implements NotificationProvider {
  abstract readonly kind: NotificationKind;
  abstract capabilities(): NotificationCapabilities;
  abstract validateRecipient(addr: NotificationAddress): boolean;
  abstract normalizeRecipient(addr: NotificationAddress): string | null;
  abstract send(config: NotificationProviderConfig, addr: NotificationAddress, msg: NotificationMessage): Promise<SendResult>;
  abstract testConnection(config: NotificationProviderConfig): Promise<HealthResult>;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(config: NotificationProviderConfig): Promise<HealthResult> {
    return this.testConnection(config);
  }
  validateConfiguration(_config: NotificationProviderConfig): ConfigValidation {
    return { ok: true, errors: [] };
  }
  async sendTemplate(config: NotificationProviderConfig, addr: NotificationAddress, msg: NotificationMessage): Promise<SendResult> {
    return this.send(config, addr, msg);
  }
  async sendBulk(config: NotificationProviderConfig, addrs: NotificationAddress[], msg: NotificationMessage): Promise<SendResult[]> {
    return Promise.all(addrs.map((a) => this.send(config, a, msg)));
  }
  async cancel(): Promise<boolean> {
    return false; // most transports can't unsend
  }
  async getStatus(): Promise<string> {
    return 'unknown';
  }
  supportsRichCards() { return this.capabilities().richCards; }
  supportsImages() { return this.capabilities().images; }
  supportsButtons() { return this.capabilities().buttons; }
  supportsMarkdown() { return this.capabilities().markdown; }
  supportsAttachments() { return this.capabilities().attachments; }
  supportsScheduling() { return this.capabilities().scheduling; }
  supportsPriority() { return this.capabilities().priority; }
  supportsReadReceipts() { return this.capabilities().readReceipts; }
  supportsTemplates() { return this.capabilities().templates; }
  supportsMedia() { return this.capabilities().media; }
  supportsTypingIndicators() { return this.capabilities().typingIndicators; }
  supportsThreads() { return this.capabilities().threads; }
  supportsReactions() { return this.capabilities().reactions; }
}

// --- shared card renderers (pure, testable) --------------------------------

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/**
 * "What happened, and to whom" — the line that turns an otherwise anonymous card
 * into a report. Without it every playback event renders as just the media title,
 * so "started watching" and "paused" are indistinguishable.
 */
export function cardContext(card: NotificationCard): string {
  return [card.action, card.actor].filter(Boolean).join(' · ');
}

/** A readable multi-line plain-text rendering of a card (Telegram/WhatsApp/email fallback). */
export function cardToText(card: NotificationCard): string {
  const lines: string[] = [];
  const head = card.subtitle ? `${card.title} — ${card.subtitle}` : card.title;
  lines.push(head);
  const context = cardContext(card);
  if (context) lines.push(context);
  const meta: string[] = [];
  if (card.badges?.length) meta.push(...card.badges);
  if (card.rating != null && card.rating > 0) meta.push(`★ ${card.rating.toFixed(1)}`);
  if (meta.length) lines.push(meta.join(' · '));
  if (card.overview) lines.push('', truncate(card.overview, 400));
  if (card.buttons?.length) {
    lines.push('');
    for (const b of card.buttons) lines.push(`${b.label}: ${b.url}`);
  }
  if (card.footer) lines.push('', card.footer);
  return lines.join('\n');
}

/** A concise, single-purpose SMS rendering — no formatting, hard length cap. */
export function cardToSms(card: NotificationCard, limit = 300): string {
  const head = card.subtitle ? `${card.title} — ${card.subtitle}` : card.title;
  const context = cardContext(card);
  const extra = card.buttons?.[0]?.url ? ` ${card.buttons[0].url}` : '';
  return truncate(`${context ? `${context}: ` : ''}${head}${extra}`, limit);
}

/** Markdown rendering of a card (Telegram MarkdownV2-safe subset kept simple). */
export function cardToMarkdown(card: NotificationCard): string {
  const lines: string[] = [];
  lines.push(`*${escapeMd(card.title)}*${card.subtitle ? ` — ${escapeMd(card.subtitle)}` : ''}`);
  const context = cardContext(card);
  if (context) lines.push(escapeMd(context));
  const meta: string[] = [];
  if (card.badges?.length) meta.push(...card.badges.map(escapeMd));
  if (card.rating != null && card.rating > 0) meta.push(`★ ${card.rating.toFixed(1)}`);
  if (meta.length) lines.push(`_${meta.join(' · ')}_`);
  if (card.overview) lines.push('', escapeMd(truncate(card.overview, 400)));
  if (card.footer) lines.push('', escapeMd(card.footer));
  return lines.join('\n');
}

function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]])/g, '\\$1');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
