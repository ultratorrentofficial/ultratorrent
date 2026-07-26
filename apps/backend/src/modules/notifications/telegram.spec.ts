import { BadRequestException } from '@nestjs/common';
import { PRESENTATION_VERSION, type NotificationPresentation } from '@ultratorrent/shared';
import { TelegramLinkingService } from './channels/telegram-linking.service';
import { NotificationChannelService } from './channels/notification-channel.service';
import { renderTelegram, renderTelegramPost } from './providers/telegram-renderer';

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
    expect(svc.offsetFor('u1')).toBe(0);
    const { code } = svc.issueCode('u1');
    svc.redeem('u1', [update({ updateId: 7, text: code })]);
    // Acknowledges through 7, so Telegram will not resend it.
    expect(svc.offsetFor('u1')).toBe(8);
  });

  it('advances the offset even when nothing matched', () => {
    const svc = new TelegramLinkingService();
    svc.redeem('u1', [update({ updateId: 4, text: 'hello' })]);
    expect(svc.offsetFor('u1')).toBe(5);
  });

  it('tracks offsets per user, because each user has their own bot', () => {
    // A single shared counter was correct for one shared bot. With per-user
    // bots it would let one user's high update id suppress another's messages,
    // and their linking would never find the code.
    const svc = new TelegramLinkingService();
    svc.redeem('u1', [update({ updateId: 900, text: 'hello' })]);
    expect(svc.offsetFor('u1')).toBe(901);
    expect(svc.offsetFor('u2')).toBe(0);

    const { code } = svc.issueCode('u2');
    const matched = svc.redeem('u2', [update({ updateId: 3, text: code })]);
    expect(matched).not.toBeNull();
  });

  it('resets a user offset when they replace their bot', () => {
    // The new bot's update stream starts from low ids; a carried-over watermark
    // would skip the very message carrying the next code.
    const svc = new TelegramLinkingService();
    svc.redeem('u1', [update({ updateId: 500, text: 'hello' })]);
    expect(svc.offsetFor('u1')).toBe(501);
    svc.resetOffset('u1');
    expect(svc.offsetFor('u1')).toBe(0);
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
        findUnique: jest.fn(async ({ where }: any) =>
          store.find(
            (r) => r.userId === where.userId_type.userId && r.type === where.userId_type.type,
          ) ?? null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          const row = store.find(
            (r) => r.userId === where.userId_type.userId && r.type === where.userId_type.type,
          );
          if (!row) throw new Error('no such row');
          Object.assign(row, data);
          return row;
        }),
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

  /**
   * A user who has already connected their own bot.
   *
   * Linking a chat requires one — the token is what sends the messages, so a
   * chat linked without it would look verified and deliver nothing.
   */
  const withBot = (userId: string, over: Record<string, unknown> = {}) => ({
    userId, type: 'telegram', enabled: true, verifiedAt: null,
    encryptedConfig: { botToken: 'enc:tok', botUsername: 'mybot' },
    deletedAt: null, consecutiveFailures: 0, ...over,
  });

  it('links a chat and marks it verified immediately', async () => {
    // Redeeming the code already proved chat control — a separate test would be
    // ceremony.
    const { svc, store } = build([withBot('u1')]);
    const view = await svc.connectTelegram('u1', '555', 'dennis');
    expect(view.verified).toBe(true);
    expect(view.maskedDestination).toBe('@dennis');
    expect(store[0].encryptedConfig.chatId).toBe('enc:555');
    // The bot token survives linking. Replacing encryptedConfig wholesale would
    // delete the credential and leave a verified connection that cannot send.
    expect(store[0].encryptedConfig.botToken).toBe('enc:tok');
  });

  it('never returns the chat id, only a handle', async () => {
    const { svc } = build([withBot('u1')]);
    const view = await svc.connectTelegram('u1', '555', 'dennis');
    expect(JSON.stringify(view)).not.toContain('555');
    expect(JSON.stringify(view)).not.toContain('tok');
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
    const { svc } = build([withBot('u1', {
      verifiedAt: new Date(),
      encryptedConfig: { botToken: 'enc:tok', botUsername: 'mybot', chatId: 'enc:555' },
    })]);
    await expect(svc.connectTelegram('u1', '555', 'dennis')).resolves.toBeDefined();
  });

  it('ignores an undecryptable row when checking for duplicates', async () => {
    // A row from before a key rotation cannot be compared, and must not block a
    // legitimate link.
    const { svc } = build([
      { userId: 'other', type: 'telegram', enabled: true, verifiedAt: new Date(),
        encryptedConfig: { chatId: 'garbage' }, deletedAt: null, consecutiveFailures: 0 },
      withBot('u1'),
    ]);
    await expect(svc.connectTelegram('u1', '555', 'dennis')).resolves.toBeDefined();
  });

  it('resolves the decrypted chat id for the delivery path only', async () => {
    const { svc } = build([withBot('u1')]);
    await svc.connectTelegram('u1', '555', 'dennis');
    // The delivery path gets the real id; nothing user-facing ever does.
    expect(await svc.resolveDestination('u1', 'telegram')).toMatchObject({ address: '555' });
  });

  it('stops resolving once the chat is disconnected', async () => {
    const { svc, store } = build([withBot('u1')]);
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
  /*
   * The playback post is deliberately short: a poster, three lines, one button.
   * What it replaced was a stacked list of "Label: value" rows plus a timestamp
   * Telegram already prints beside every message — a monitoring alert, not a
   * notification about a film someone just put on.
   */
  const movie = () => presentation({
    media: { kind: 'movie', primary: 'Dune: Part Two (2024)', secondary: null },
    context: '4K HDR • Living Room Apple TV',
    summary: { text: 'Dennis started watching Dune: Part Two (2024)', emphasis: 'Dune: Part Two (2024)' },
  });

  const episode = () => presentation({
    media: { kind: 'episode', primary: 'The Last of Us', secondary: 'S01E03 • Long Long Time' },
    context: '1080p • Bedroom TV',
    summary: { text: 'Dennis started watching The Last of Us - S01E03', emphasis: 'The Last of Us - S01E03' },
  });

  it('renders a movie as phrase, title, context — and nothing else', () => {
    const out = renderTelegram(movie());
    expect(out).toBe(
      '<b>Dennis started watching</b>\n' +
      '<b>Dune: Part Two (2024)</b>\n' +
      '\n' +
      '4K HDR • Living Room Apple TV',
    );
  });

  it('renders an episode with the series above the episode line', () => {
    const out = renderTelegram(episode());
    expect(out).toBe(
      '<b>Dennis started watching</b>\n' +
      '<b>The Last of Us</b>\n' +
      'S01E03 • Long Long Time\n' +
      '\n' +
      '1080p • Bedroom TV',
    );
  });

  it('never uses the internal event name as the visible headline', () => {
    const out = renderTelegram(movie());
    // "User Started Watching" is an event label; a person reads a sentence.
    expect(out).not.toContain('User Started');
    expect(out).not.toContain('media_server.user_started_watching');
  });

  it('carries no labels, dividers, or duplicate timestamp', () => {
    const out = renderTelegram(movie());
    for (const banned of ['User:', 'Media:', 'Device:', 'Time:', 'Quality:', 'Player:', '—————', '---']) {
      expect(out).not.toContain(banned);
    }
    // Telegram stamps every message itself; repeating it is noise.
    expect(out).not.toContain('2026');
  });

  it('stays within five short lines', () => {
    expect(renderTelegram(episode()).split('\n').length).toBeLessThanOrEqual(5);
  });

  it('drops the context line rather than inventing one', () => {
    const out = renderTelegram(presentation({ ...movie(), context: null }));
    expect(out).toBe('<b>Dennis started watching</b>\n<b>Dune: Part Two (2024)</b>');
  });

  it('reads naturally when the user identity was redacted', () => {
    const out = renderTelegram(presentation({
      ...movie(),
      summary: { text: 'A user started watching Dune: Part Two (2024)', emphasis: 'Dune: Part Two (2024)' },
      context: '4K HDR',
    }));
    expect(out).toContain('<b>A user started watching</b>');
    expect(out).not.toContain('Dennis');
  });

  it('says "resumed" when the builder decided it was a resume', () => {
    const out = renderTelegram(presentation({
      ...movie(),
      summary: { text: 'Dennis resumed watching Dune: Part Two (2024)', emphasis: 'Dune: Part Two (2024)' },
      context: 'Resumed at 42% • Living Room Apple TV',
    }));
    expect(out).toContain('<b>Dennis resumed watching</b>');
    expect(out).toContain('Resumed at 42%');
  });

  it('escapes a media title that would otherwise be markup', () => {
    const out = renderTelegram(presentation({
      ...movie(),
      media: { kind: 'movie', primary: '<script>alert(1)</script>', secondary: null },
    }));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('neutralises a mention so a title cannot page a group', () => {
    const out = renderTelegram(presentation({
      ...movie(),
      media: { kind: 'movie', primary: '@everyone (2024)', secondary: null },
    }));
    // Telegram only resolves a mention for a real username; the point is that it
    // is inert text and cannot become an entity through markup.
    expect(out).toContain('@everyone (2024)');
    expect(out).not.toContain('<a ');
  });

  it('truncates a long title on characters, not code units', () => {
    const out = renderTelegramPost(presentation({
      ...movie(),
      media: { kind: 'movie', primary: '😀'.repeat(2000), secondary: null },
    }), { withPhoto: true });
    expect(Array.from(out.caption).length).toBeLessThanOrEqual(1024);
    // A sliced surrogate pair is invalid UTF-8 and Telegram rejects the send.
    expect(out.caption).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('uses the 1024 caption limit for a photo and 4096 for a message', () => {
    const long = presentation({ ...movie(), media: { kind: 'movie', primary: 'x'.repeat(9000), secondary: null } });
    expect(Array.from(renderTelegramPost(long, { withPhoto: true }).caption).length).toBeLessThanOrEqual(1024);
    expect(Array.from(renderTelegramPost(long, { withPhoto: false }).caption).length).toBeLessThanOrEqual(4096);
  });

  it('publishes no URL in the caption itself', () => {
    expect(renderTelegram(movie())).not.toContain('http');
  });

  it('renders a Spanish post from a Spanish presentation', () => {
    const out = renderTelegram(presentation({
      ...movie(),
      summary: { text: 'Dennis comenzó a ver Dune: Part Two (2024)', emphasis: 'Dune: Part Two (2024)' },
      context: '4K HDR • Apple TV de la sala',
    }));
    expect(out).toBe(
      '<b>Dennis comenzó a ver</b>\n' +
      '<b>Dune: Part Two (2024)</b>\n' +
      '\n' +
      '4K HDR • Apple TV de la sala',
    );
  });

  /* ------------------------------------------------------------ the button */

  it('builds exactly one absolute button', () => {
    const { button } = renderTelegramPost(movie(), { appUrl: 'https://ultra.example.com' });
    expect(button).toEqual({
      text: 'View', url: 'https://ultra.example.com/media-server-analytics',
    });
  });

  it('omits the button when no app URL is configured', () => {
    expect(renderTelegramPost(movie(), { appUrl: null }).button).toBeNull();
    expect(renderTelegramPost(movie()).button).toBeNull();
  });

  it('refuses a base URL that is not http(s)', () => {
    // Telegram rejects any other scheme, and a button that never opens reads as
    // a broken notification.
    expect(renderTelegramPost(movie(), { appUrl: 'ftp://x.example.com' }).button).toBeNull();
    expect(renderTelegramPost(movie(), { appUrl: 'javascript:alert(1)' }).button).toBeNull();
  });

  it('tolerates a trailing slash on the configured URL', () => {
    const { button } = renderTelegramPost(movie(), { appUrl: 'https://ultra.example.com///' });
    expect(button!.url).toBe('https://ultra.example.com/media-server-analytics');
  });

  /* ------------------------------- non-playback keeps the informative style */

  it('still renders facts for a non-playback event', () => {
    const out = renderTelegram(presentation({
      eventKey: 'system.storage_critical',
      facts: [{ icon: 'disk', label: 'Free space', value: '2%' }],
    }));
    // A storage warning genuinely wants its numbers.
    expect(out).toContain('2%');
  });

  it('escapes fact values too', () => {
    const out = renderTelegram(presentation({
      eventKey: 'system.storage_critical',
      facts: [{ icon: 'user', label: 'User', value: '<b>hax</b>' }],
    }));
    expect(out).not.toContain('<b>hax</b>');
    expect(out).toContain('&lt;b&gt;hax&lt;/b&gt;');
  });
});
