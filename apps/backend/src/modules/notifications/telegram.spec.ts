import { BadRequestException } from '@nestjs/common';
import { PRESENTATION_VERSION, type NotificationPresentation } from '@ultratorrent/shared';
import { TelegramLinkingService } from './channels/telegram-linking.service';
import { NotificationChannelService } from './channels/notification-channel.service';
import { renderTelegram } from './providers/telegram-renderer';

const update = (over: Partial<{ updateId: number; chatId: string; text: string; fromUsername: string | null }> = {}) => ({
  updateId: 1, chatId: '555', text: '', fromUsername: 'dennis', ...over,
});

/* -------------------------------------------------------------------- linking */

describe('TelegramLinkingService', () => {
  it('issues a six-digit code and redeems it from the chat that sent it', () => {
    const svc = new TelegramLinkingService();
    const { code } = svc.issueCode('u1');
    expect(code).toMatch(/^\d{6}$/);

    const matched = svc.redeem('u1', [update({ text: code })]);
    expect(matched).toEqual({ chatId: '555', username: 'dennis' });
  });

  it('accepts a code sent with surrounding text', () => {
    const svc = new TelegramLinkingService();
    const { code } = svc.issueCode('u1');
    expect(svc.redeem('u1', [update({ text: `my code is ${code} thanks` })])).not.toBeNull();
  });

  it('is single use — a replayed message cannot link a second chat', () => {
    const svc = new TelegramLinkingService();
    const { code } = svc.issueCode('u1');

    expect(svc.redeem('u1', [update({ text: code })])).not.toBeNull();
    // The same message arriving again must not work.
    expect(svc.redeem('u1', [update({ updateId: 2, chatId: '999', text: code })])).toBeNull();
  });

  it('refuses a code belonging to a different user', () => {
    const svc = new TelegramLinkingService();
    const { code } = svc.issueCode('u1');
    // Someone else's code is not theirs to redeem, even with the plaintext.
    expect(svc.redeem('u2', [update({ text: code })])).toBeNull();
    // And it still works for its rightful owner.
    expect(svc.redeem('u1', [update({ text: code })])).not.toBeNull();
  });

  it('invalidates the previous code when a new one is issued', () => {
    const svc = new TelegramLinkingService();
    const first = svc.issueCode('u1').code;
    const second = svc.issueCode('u1').code;

    // A code read over someone's shoulder stops working the moment they retry.
    expect(svc.redeem('u1', [update({ text: first })])).toBeNull();
    expect(svc.redeem('u1', [update({ text: second })])).not.toBeNull();
  });

  it('expires a code rather than honouring it forever', () => {
    jest.useFakeTimers();
    try {
      const svc = new TelegramLinkingService();
      const { code, expiresInSeconds } = svc.issueCode('u1');
      expect(expiresInSeconds).toBe(600);

      jest.advanceTimersByTime(11 * 60 * 1000);
      expect(svc.redeem('u1', [update({ text: code })])).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rate-limits code requests', () => {
    const svc = new TelegramLinkingService();
    for (let i = 0; i < 5; i += 1) svc.issueCode('u1');
    expect(() => svc.issueCode('u1')).toThrow(BadRequestException);
    // A different user is unaffected — the limit is per person, not global.
    expect(() => svc.issueCode('u2')).not.toThrow();
  });

  it('advances its offset past everything it has seen, so nothing replays', () => {
    const svc = new TelegramLinkingService();
    expect(svc.offset).toBe(0);
    const { code } = svc.issueCode('u1');
    svc.redeem('u1', [update({ updateId: 7, text: code })]);
    // Acknowledges through 7, so Telegram will not resend it.
    expect(svc.offset).toBe(8);
  });

  it('advances the offset even when nothing matched', () => {
    const svc = new TelegramLinkingService();
    svc.redeem('u1', [update({ updateId: 4, text: 'hello' })]);
    expect(svc.offset).toBe(5);
  });

  it('ignores messages that carry no code', () => {
    const svc = new TelegramLinkingService();
    svc.issueCode('u1');
    expect(svc.redeem('u1', [update({ text: 'hello there' })])).toBeNull();
  });

  it('drops a pending code on cancel', () => {
    const svc = new TelegramLinkingService();
    const { code } = svc.issueCode('u1');
    svc.cancel('u1');
    expect(svc.redeem('u1', [update({ text: code })])).toBeNull();
  });
});

/* --------------------------------------------------------- duplicate chats */

describe('Telegram chat linking', () => {
  const cipher = {
    encrypt: (v: string) => `enc:${v}`,
    decrypt: (v: string) => {
      if (!v.startsWith('enc:')) throw new Error('bad key');
      return v.slice(4);
    },
  };

  const build = (rows: any[] = []) => {
    const store = [...rows];
    const prisma: any = {
      userNotificationChannel: {
        findMany: jest.fn(async ({ where }: any) =>
          store.filter((r) => {
            if (where.type && r.type !== where.type) return false;
            if (where.userId && r.userId !== where.userId) return false;
            if (where.deletedAt === null && r.deletedAt !== null) return false;
            return true;
          }),
        ),
        findFirst: jest.fn(async ({ where }: any) =>
          store.find((r) => {
            if (r.userId !== where.userId || r.type !== where.type) return false;
            if (where.deletedAt === null && r.deletedAt !== null) return false;
            if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
            if (where.verifiedAt?.not === null && r.verifiedAt === null) return false;
            return true;
          }) ?? null,
        ),
        upsert: jest.fn(async ({ where, create, update: upd }: any) => {
          const existing = store.find(
            (r) => r.userId === where.userId_type.userId && r.type === where.userId_type.type,
          );
          if (existing) { Object.assign(existing, upd); return existing; }
          const row = { consecutiveFailures: 0, deletedAt: null, ...create };
          store.push(row);
          return row;
        }),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    return { svc: new NotificationChannelService(prisma, cipher as any), store };
  };

  it('links a chat and marks it verified immediately', async () => {
    // Redeeming the code already proved chat control — a separate test would be
    // ceremony.
    const { svc, store } = build();
    const view = await svc.connectTelegram('u1', '555', 'dennis');
    expect(view.verified).toBe(true);
    expect(view.maskedDestination).toBe('@dennis');
    expect(store[0].encryptedConfig.chatId).toBe('enc:555');
  });

  it('never returns the chat id, only a handle', async () => {
    const { svc } = build();
    const view = await svc.connectTelegram('u1', '555', 'dennis');
    expect(JSON.stringify(view)).not.toContain('555');
  });

  it('refuses a chat already linked to another account', async () => {
    const { svc } = build([{
      userId: 'other', type: 'telegram', enabled: true, verifiedAt: new Date(),
      encryptedConfig: { chatId: 'enc:555' }, deletedAt: null, consecutiveFailures: 0,
    }]);
    // Without this, two users would each silently receive the other's messages.
    await expect(svc.connectTelegram('u1', '555', 'dennis')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets the SAME user re-link their own chat', async () => {
    const { svc } = build([{
      userId: 'u1', type: 'telegram', enabled: true, verifiedAt: new Date(),
      encryptedConfig: { chatId: 'enc:555' }, deletedAt: null, consecutiveFailures: 0,
    }]);
    await expect(svc.connectTelegram('u1', '555', 'dennis')).resolves.toBeDefined();
  });

  it('ignores an undecryptable row when checking for duplicates', async () => {
    // A row from before a key rotation cannot be compared, and must not block a
    // legitimate link.
    const { svc } = build([{
      userId: 'other', type: 'telegram', enabled: true, verifiedAt: new Date(),
      encryptedConfig: { chatId: 'garbage' }, deletedAt: null, consecutiveFailures: 0,
    }]);
    await expect(svc.connectTelegram('u1', '555', 'dennis')).resolves.toBeDefined();
  });

  it('resolves the decrypted chat id for the delivery path only', async () => {
    const { svc } = build();
    await svc.connectTelegram('u1', '555', 'dennis');
    // The delivery path gets the real id; nothing user-facing ever does.
    expect(await svc.resolveDestination('u1', 'telegram')).toMatchObject({ address: '555' });
  });

  it('stops resolving once the chat is disconnected', async () => {
    const { svc, store } = build();
    await svc.connectTelegram('u1', '555', 'dennis');
    store[0].deletedAt = new Date();
    expect(await svc.resolveDestination('u1', 'telegram')).toBeNull();
  });
});

/* ------------------------------------------------------------------ renderer */

const presentation = (over: Partial<NotificationPresentation> = {}): NotificationPresentation => ({
  version: PRESENTATION_VERSION,
  eventKey: 'media_server.user_started_watching',
  accent: 'started',
  icon: 'play',
  headline: { lead: 'User Started', trail: 'Watching' },
  summary: { text: 'Dennis started watching Dune (2021)', emphasis: 'Dune (2021)' },
  avatar: null,
  artwork: { kind: 'notification', id: 'n1', aspect: 'poster', alt: 'Poster', mediaType: 'movie' },
  facts: [{ icon: 'user', label: 'User', value: 'Dennis' }],
  progress: null,
  status: 'Now Playing',
  action: { label: 'View', href: '/media-server-analytics', icon: 'monitor' },
  timestamp: '2026-07-25T20:00:00Z',
  ...over,
});

describe('telegram rendering', () => {
  it('bolds the headline and the emphasized span', () => {
    const out = renderTelegram(presentation());
    expect(out).toContain('<b>User Started Watching</b>');
    expect(out).toContain('<b>Dune (2021)</b>');
    expect(out).toContain('▶️');
  });

  it('escapes a title that would otherwise be markup', () => {
    const out = renderTelegram(presentation({
      summary: { text: 'Dennis watched <script>alert(1)</script>', emphasis: '<script>alert(1)</script>' },
    }));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes fact values too', () => {
    const out = renderTelegram(presentation({
      facts: [{ icon: 'user', label: 'User', value: '<b>hax</b>' }],
    }));
    expect(out).not.toContain('<b>hax</b>');
    expect(out).toContain('&lt;b&gt;hax&lt;/b&gt;');
  });

  it('stays inside the 4096-character limit', () => {
    const out = renderTelegram(presentation({ summary: { text: 'x'.repeat(9000), emphasis: null } }));
    expect(Array.from(out).length).toBeLessThanOrEqual(4096);
  });

  it('omits artwork rather than publishing a URL for it', () => {
    const out = renderTelegram(presentation());
    expect(out).not.toContain('http');
  });

  it('includes progress when the presentation has it', () => {
    const out = renderTelegram(presentation({
      progress: { percent: 42, label: '42% watched', positionLabel: null },
    }));
    expect(out).toContain('42% watched');
  });
});
