import type { NotificationKind, NotificationProvider } from './notification-provider';
import { EmailNotificationProvider } from './providers/email.provider';
import { TelegramNotificationProvider } from './providers/telegram.provider';
import { SmsNotificationProvider } from './providers/twilio-sms.provider';
import { WhatsAppNotificationProvider } from './providers/twilio-whatsapp.provider';

/** A config field the UI renders for a provider; `secret` fields are encrypted. */
export interface ProviderConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

interface ProviderDescriptor {
  factory: () => NotificationProvider;
  name: string;
  /** Recipient attribute this provider addresses. */
  recipientField: 'email' | 'phone' | 'telegramChatId' | 'whatsappNumber';
  configFields: ProviderConfigField[];
}

const DESCRIPTORS: Partial<Record<NotificationKind, ProviderDescriptor>> = {
  email: {
    factory: () => new EmailNotificationProvider(),
    name: 'Email',
    recipientField: 'email',
    configFields: [
      { key: 'host', label: 'SMTP host', type: 'string', required: true },
      { key: 'port', label: 'Port', type: 'number' },
      { key: 'secure', label: 'Use TLS/SSL', type: 'boolean' },
      { key: 'auth', label: 'Use authentication', type: 'boolean' },
      { key: 'user', label: 'Username', type: 'string' },
      { key: 'pass', label: 'Password', type: 'string', secret: true },
      { key: 'fromName', label: 'From name', type: 'string' },
      { key: 'fromAddress', label: 'From address', type: 'string', required: true },
    ],
  },
  telegram: {
    factory: () => new TelegramNotificationProvider(),
    name: 'Telegram',
    recipientField: 'telegramChatId',
    configFields: [{ key: 'botToken', label: 'Bot token', type: 'string', secret: true, required: true }],
  },
  sms: {
    factory: () => new SmsNotificationProvider(),
    name: 'SMS (Twilio)',
    recipientField: 'phone',
    configFields: [
      { key: 'accountSid', label: 'Account SID', type: 'string', required: true },
      { key: 'authToken', label: 'Auth token', type: 'string', secret: true, required: true },
      { key: 'fromNumber', label: 'From number (E.164)', type: 'string', required: true, placeholder: '+15551234567' },
    ],
  },
  whatsapp: {
    factory: () => new WhatsAppNotificationProvider(),
    name: 'WhatsApp (Twilio)',
    recipientField: 'whatsappNumber',
    configFields: [
      { key: 'accountSid', label: 'Account SID', type: 'string', required: true },
      { key: 'authToken', label: 'Auth token', type: 'string', secret: true, required: true },
      { key: 'fromNumber', label: 'WhatsApp number (E.164)', type: 'string', required: true, placeholder: '+15551234567' },
    ],
  },
};

/** Provider kinds implemented today (future kinds add a descriptor entry). */
export const NOTIFICATION_PROVIDER_KINDS = Object.keys(DESCRIPTORS) as NotificationKind[];

/** Resolve a provider instance for a channel's kind. Throws on unknown/unimplemented. */
export function getNotificationProvider(kind: NotificationKind): NotificationProvider {
  const d = DESCRIPTORS[kind];
  if (!d) throw new Error(`Unknown or unimplemented notification provider: ${kind}`);
  return d.factory();
}

/** Config keys that must be encrypted at rest for a provider kind. */
export function secretFieldsFor(kind: NotificationKind): string[] {
  return (DESCRIPTORS[kind]?.configFields ?? []).filter((f) => f.secret).map((f) => f.key);
}

/** Which recipient attribute a provider kind addresses. */
export function recipientFieldFor(kind: NotificationKind): ProviderDescriptor['recipientField'] | null {
  return DESCRIPTORS[kind]?.recipientField ?? null;
}

/** Catalog for the UI: registered kinds + capabilities + config schema. */
export function providerCatalog() {
  return NOTIFICATION_PROVIDER_KINDS.map((kind) => {
    const d = DESCRIPTORS[kind]!;
    return {
      kind,
      name: d.name,
      recipientField: d.recipientField,
      capabilities: d.factory().capabilities(),
      configFields: d.configFields,
    };
  });
}
