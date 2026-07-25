import type { ConnectionBackedChannelType, NotificationChannelHealth } from '@ultratorrent/shared';

/** Per-type connection config, before encryption. */
export interface EmailChannelConfig {
  /** Personal destination. The SMTP transport itself is platform infrastructure. */
  address: string;
}
export interface TelegramChannelConfig {
  /** Chat id bound by the linking flow — never typed in by the user. */
  chatId: string;
}
export interface WhatsAppChannelConfig {
  /** E.164, normalized on write. */
  phone: string;
}
export interface DiscordChannelConfig {
  /** Full webhook URL. Secret: encrypted at rest and never returned. */
  webhookUrl: string;
}

export type PersonalChannelConfig =
  | EmailChannelConfig
  | TelegramChannelConfig
  | WhatsAppChannelConfig
  | DiscordChannelConfig;

/** What the API may return about a connection. Never the config itself. */
export interface PersonalChannelView {
  id: string;
  type: ConnectionBackedChannelType;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  /** Display-safe destination — "d•••s@gmail.com", never the raw value. */
  destinationMask: string | null;
  verified: boolean;
  verifiedAt: string | null;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  health: NotificationChannelHealth;
  createdAt: string;
}

export interface ValidationResult {
  valid: boolean;
  /** Normalized config to store (e.g. E.164 phone), when valid. */
  config?: PersonalChannelConfig;
  /** Display-safe destination derived from the config. */
  destinationMask?: string;
  reason?: string;
}
