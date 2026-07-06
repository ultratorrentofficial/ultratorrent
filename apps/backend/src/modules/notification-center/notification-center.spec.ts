import { cardToMarkdown, cardToSms, cardToText, type NotificationCard } from './notification-provider';
import { getNotificationProvider, providerCatalog, secretFieldsFor, NOTIFICATION_PROVIDER_KINDS } from './provider-registry';
import { EmailNotificationProvider, renderEmailHtml } from './providers/email.provider';
import { TelegramNotificationProvider } from './providers/telegram.provider';
import { SmsNotificationProvider } from './providers/twilio-sms.provider';
import { WhatsAppNotificationProvider } from './providers/twilio-whatsapp.provider';
import { buildCard, buildMessage, evalConditionals, interpolate, renderString } from './template-render';
import { evaluateConditions, type RuleCondition } from './rule-engine.service';
import { inQuietHours } from './delivery.service';

const card: NotificationCard = {
  title: 'Dune: Part Two',
  subtitle: 'S01E02',
  overview: 'Paul Atreides unites with the Fremen.',
  posterUrl: 'https://example/poster.jpg',
  badges: ['2024', '4K'],
  rating: 8.4,
  genres: ['Sci-Fi'],
  runtime: 166,
  buttons: [{ label: 'View', url: 'https://example/watch' }],
  footer: 'PLEX',
};

describe('provider registry', () => {
  it('lists the four implemented providers with capabilities + config schema', () => {
    expect(NOTIFICATION_PROVIDER_KINDS.sort()).toEqual(['email', 'sms', 'telegram', 'whatsapp']);
    const cat = providerCatalog();
    expect(cat).toHaveLength(4);
    expect(cat.find((c) => c.kind === 'email')?.recipientField).toBe('email');
    expect(cat.find((c) => c.kind === 'telegram')?.configFields.some((f) => f.key === 'botToken' && f.secret)).toBe(true);
  });
  it('resolves the right provider class and throws on unknown', () => {
    expect(getNotificationProvider('email')).toBeInstanceOf(EmailNotificationProvider);
    expect(getNotificationProvider('telegram')).toBeInstanceOf(TelegramNotificationProvider);
    expect(getNotificationProvider('sms')).toBeInstanceOf(SmsNotificationProvider);
    expect(getNotificationProvider('whatsapp')).toBeInstanceOf(WhatsAppNotificationProvider);
    expect(() => getNotificationProvider('discord')).toThrow();
  });
  it('reports which config fields are secret', () => {
    expect(secretFieldsFor('email')).toEqual(['pass']);
    expect(secretFieldsFor('sms')).toEqual(['authToken']);
  });
});

describe('provider capabilities + supports*()', () => {
  it('email supports rich cards, images, buttons; not markdown', () => {
    const p = new EmailNotificationProvider();
    expect(p.supportsRichCards()).toBe(true);
    expect(p.supportsImages()).toBe(true);
    expect(p.supportsButtons()).toBe(true);
    expect(p.supportsMarkdown()).toBe(false);
  });
  it('SMS supports nothing rich (plain text only)', () => {
    const p = new SmsNotificationProvider();
    expect(p.supportsRichCards()).toBe(false);
    expect(p.supportsImages()).toBe(false);
    expect(p.supportsMarkdown()).toBe(false);
  });
  it('telegram supports markdown + buttons + media', () => {
    const p = new TelegramNotificationProvider();
    expect(p.supportsMarkdown()).toBe(true);
    expect(p.supportsButtons()).toBe(true);
    expect(p.supportsMedia()).toBe(true);
  });
});

describe('recipient validation + normalization', () => {
  const email = new EmailNotificationProvider();
  const sms = new SmsNotificationProvider();
  const tg = new TelegramNotificationProvider();
  const wa = new WhatsAppNotificationProvider();
  it('email', () => {
    expect(email.validateRecipient({ email: 'a@b.co' })).toBe(true);
    expect(email.validateRecipient({ email: 'nope' })).toBe(false);
    expect(email.normalizeRecipient({ email: '  A@B.CO ' })).toBe('a@b.co');
  });
  it('sms E.164', () => {
    expect(sms.validateRecipient({ phone: '+1 (555) 123-4567' })).toBe(true);
    expect(sms.validateRecipient({ phone: '12' })).toBe(false);
    expect(sms.normalizeRecipient({ phone: '15551234567' })).toBe('+15551234567');
  });
  it('telegram numeric chat id', () => {
    expect(tg.validateRecipient({ telegramChatId: '-1001234' })).toBe(true);
    expect(tg.validateRecipient({ telegramChatId: 'abc' })).toBe(false);
  });
  it('whatsapp falls back to phone + strips prefix', () => {
    expect(wa.normalizeRecipient({ whatsappNumber: 'whatsapp:+15551234567' })).toBe('+15551234567');
    expect(wa.validateRecipient({ phone: '+15551234567' })).toBe(true);
  });
});

describe('card renderers', () => {
  it('cardToText includes title, badges, overview and buttons', () => {
    const t = cardToText(card);
    expect(t).toContain('Dune: Part Two — S01E02');
    expect(t).toContain('★ 8.4');
    expect(t).toContain('View: https://example/watch');
  });
  it('cardToSms is concise and length-capped', () => {
    const s = cardToSms(card, 40);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).toContain('Dune');
  });
  it('cardToMarkdown escapes markdown control chars', () => {
    const md = cardToMarkdown({ ...card, title: 'A*B_C' });
    expect(md).toContain('A\\*B\\_C');
  });
});

describe('template rendering', () => {
  it('interpolates {{vars}} and drops unknowns', () => {
    expect(interpolate('Hi {{name}} ({{missing}})', { name: 'Dennis' })).toBe('Hi Dennis ()');
  });
  it('resolves {{#if}} / {{#unless}} blocks', () => {
    expect(evalConditionals('{{#if a}}Y{{/if}}{{#unless b}}N{{/unless}}', { a: 1, b: 0 })).toBe('YN');
  });
  it('renderString trims + interpolates', () => {
    expect(renderString('  {{x}}!  ', { x: 'ok' })).toBe('ok!');
  });
  it('buildCard derives a card from event vars', () => {
    const c = buildCard({}, { mediaTitle: 'Foo', overview: 'Bar', posterUrl: 'p', rating: 7, year: 2024, watchUrl: 'w' });
    expect(c.title).toBe('Foo');
    expect(c.badges).toContain('2024');
    expect(c.buttons?.[0]).toEqual({ label: 'View', url: 'w' });
  });
  it('buildMessage picks a concise SMS body and a markdown Telegram body', () => {
    const vars = { mediaTitle: 'Dune', overview: 'x'.repeat(500) };
    const sms = buildMessage({}, vars, 'sms');
    expect(sms.text.length).toBeLessThanOrEqual(300);
    const tg = buildMessage({}, vars, 'telegram');
    expect(tg.markdown).toContain('*Dune*');
  });
  it('buildMessage prefers a channel-specific template body when provided', () => {
    const m = buildMessage({ sms: 'SMS: {{mediaTitle}}' }, { mediaTitle: 'Dune' }, 'sms');
    expect(m.text).toBe('SMS: Dune');
  });
});

describe('rule engine conditions', () => {
  const payload = { userDisplayName: 'Dennis', bitrate: 12000, mediaType: 'movie', genres: ['Sci-Fi'] };
  it('empty conditions always match', () => {
    expect(evaluateConditions([], payload)).toBe(true);
  });
  it('evaluates operators (AND)', () => {
    const conds: RuleCondition[] = [
      { field: 'mediaType', op: 'eq', value: 'movie' },
      { field: 'bitrate', op: 'gt', value: 8000 },
      { field: 'userDisplayName', op: 'contains', value: 'denn' },
      { field: 'genres', op: 'exists' },
    ];
    expect(evaluateConditions(conds, payload)).toBe(true);
    expect(evaluateConditions([{ field: 'bitrate', op: 'lt', value: 8000 }], payload)).toBe(false);
  });
  it('supports in + regex', () => {
    expect(evaluateConditions([{ field: 'mediaType', op: 'in', value: ['movie', 'tv'] }], payload)).toBe(true);
    expect(evaluateConditions([{ field: 'userDisplayName', op: 'regex', value: '^Den' }], payload)).toBe(true);
  });
});

describe('quiet hours', () => {
  it('detects a window not crossing midnight', () => {
    expect(inQuietHours({ enabled: true, start: '22:00', end: '08:00' }, { h: 23, m: 0 })).toBe(true);
    expect(inQuietHours({ enabled: true, start: '22:00', end: '08:00' }, { h: 12, m: 0 })).toBe(false);
  });
  it('detects a window crossing midnight', () => {
    expect(inQuietHours({ enabled: true, start: '22:00', end: '06:00' }, { h: 2, m: 0 })).toBe(true);
    expect(inQuietHours({ enabled: false, start: '22:00', end: '06:00' }, { h: 2, m: 0 })).toBe(false);
  });
});

describe('email HTML rendering', () => {
  it('renders a rich card with poster + escaped title + button', () => {
    const html = renderEmailHtml({ card: { ...card, title: '<b>X</b>' }, text: '' });
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(html).toContain('https://example/poster.jpg');
    expect(html).toContain('https://example/watch');
    expect(html).toContain('bgcolor="#0b0b12"');
  });
});
