import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PRESENTATION_VERSION, type NotificationPresentation } from '@ultratorrent/shared';
import { isValidEmail, maskEmail } from './channels/channel-validators';
import { NotificationChannelService } from './channels/notification-channel.service';
import { NotificationDeliveryWorker } from './delivery/delivery-worker.service';
import { renderEmailHtml, renderEmailSubject, renderEmailText } from './providers/email-renderer';

/* ------------------------------------------------------------------ validators */

describe('email validation and masking', () => {
  it('accepts ordinary addresses', () => {
    for (const ok of ['a@b.co', 'dennis.ayala@example.com', 'x+tag@sub.domain.org']) {
      expect(isValidEmail(ok)).toBe(true);
    }
  });

  it('rejects what people actually type wrong', () => {
    for (const bad of ['', '   ', 'no-at-sign', 'a@b', 'a@@b.co', 'a b@c.co', '@b.co', 'a@']) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it('rejects an absurdly long address rather than storing it', () => {
    expect(isValidEmail(`${'a'.repeat(250)}@b.co`)).toBe(false);
  });

  it('masks the local part but keeps the domain recognisable', () => {
    expect(maskEmail('dennis@example.com')).toBe('de••••@example.com');
    expect(maskEmail('ab@x.io')).toBe('ab•••@x.io');
  });

  it('never leaks the full local part through the mask', () => {
    const masked = maskEmail('verysecretname@example.com');
    expect(masked).not.toContain('verysecretname');
    expect(masked.startsWith('ve')).toBe(true);
  });
});

/* ---------------------------------------------------------------- channels */

describe('NotificationChannelService', () => {
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
          store.filter((r) => r.userId === where.userId && (where.deletedAt !== null || r.deletedAt === null)),
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
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const existing = store.find(
            (r) => r.userId === where.userId_type.userId && r.type === where.userId_type.type,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const row = { verifiedAt: null, consecutiveFailures: 0, deletedAt: null, ...create };
          store.push(row);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const hit = store.filter(
            (r) => r.userId === where.userId && r.type === where.type && r.deletedAt === null,
          );
          hit.forEach((r) => {
            for (const [k, v] of Object.entries(data)) {
              r[k] = (v as any)?.increment !== undefined ? (r[k] ?? 0) + (v as any).increment : v;
            }
          });
          return { count: hit.length };
        }),
      },
    };
    return { svc: new NotificationChannelService(prisma, cipher as any), store };
  };

  it('stores the address encrypted and shows only a mask', async () => {
    const { svc, store } = build();
    const view = await svc.connectEmail('u1', 'dennis@example.com');
    expect(store[0].encryptedConfig.address).toBe('enc:dennis@example.com');
    expect(view.maskedDestination).toBe('de••••@example.com');
    // The plaintext must not appear anywhere in what the API returns.
    expect(JSON.stringify(view)).not.toContain('dennis@example.com');
  });

  it('rejects an invalid address before storing anything', async () => {
    const { svc, store } = build();
    await expect(svc.connectEmail('u1', 'nope')).rejects.toBeInstanceOf(BadRequestException);
    expect(store).toHaveLength(0);
  });

  it('stores a new connection UNVERIFIED', async () => {
    const { svc } = build();
    const view = await svc.connectEmail('u1', 'a@b.co');
    expect(view.verified).toBe(false);
    expect(view.health).toBe('unverified');
  });

  it('resets verification when the address is re-pointed', async () => {
    const { svc } = build();
    await svc.connectEmail('u1', 'a@b.co');
    await svc.markVerified('u1', 'email');
    expect((await svc.list('u1')).find((c) => c.type === 'email')!.verified).toBe(true);

    // A typo must not inherit the trust the old address earned.
    const repointed = await svc.connectEmail('u1', 'typo@b.co');
    expect(repointed.verified).toBe(false);
  });

  it('refuses to resolve a destination that is not verified', async () => {
    const { svc } = build();
    await svc.connectEmail('u1', 'a@b.co');
    expect(await svc.resolveDestination('u1', 'email')).toBeNull();

    await svc.markVerified('u1', 'email');
    expect(await svc.resolveDestination('u1', 'email')).toMatchObject({ address: 'a@b.co' });
  });

  it('refuses to resolve a disconnected channel', async () => {
    const { svc } = build();
    await svc.connectEmail('u1', 'a@b.co');
    await svc.markVerified('u1', 'email');
    await svc.disconnect('u1', 'email');
    expect(await svc.resolveDestination('u1', 'email')).toBeNull();
  });

  it('returns null rather than throwing when the key no longer decrypts', async () => {
    // A rotated encryption key is terminal, not a crash.
    const { svc } = build([{
      userId: 'u1', type: 'email', enabled: true, verifiedAt: new Date(),
      encryptedConfig: { address: 'garbage' }, deletedAt: null, consecutiveFailures: 0,
    }]);
    expect(await svc.resolveDestination('u1', 'email')).toBeNull();
  });

  it('reports failing health after repeated failures', async () => {
    const { svc } = build();
    await svc.connectEmail('u1', 'a@b.co');
    await svc.markVerified('u1', 'email');
    for (let i = 0; i < 3; i += 1) await svc.recordFailure('u1', 'email', 'refused');
    expect((await svc.list('u1')).find((c) => c.type === 'email')!.health).toBe('failing');
  });

  it('clears the failure streak on a success', async () => {
    const { svc } = build();
    await svc.connectEmail('u1', 'a@b.co');
    await svc.markVerified('u1', 'email');
    await svc.recordFailure('u1', 'email', 'refused');
    await svc.recordSuccess('u1', 'email');
    const view = (await svc.list('u1')).find((c) => c.type === 'email')!;
    expect(view.consecutiveFailures).toBe(0);
    expect(view.health).toBe('healthy');
  });

  it('reports every channel, connected or not', async () => {
    const { svc } = build();
    const list = await svc.list('u1');
    expect(list.map((c) => c.type).sort()).toEqual(['discord', 'email', 'telegram']);
    expect(list.every((c) => !c.connected)).toBe(true);
  });

  it('refuses to disconnect something that is not connected', async () => {
    const { svc } = build();
    await expect(svc.disconnect('u1', 'email')).rejects.toBeInstanceOf(NotFoundException);
  });
});

/* ---------------------------------------------------------------- renderer */

const presentation = (over: Partial<NotificationPresentation> = {}): NotificationPresentation => ({
  version: PRESENTATION_VERSION,
  eventKey: 'torrent.completed',
  accent: 'success',
  icon: 'download',
  headline: { lead: 'Download', trail: 'Complete' },
  summary: { text: 'Dune.2021 finished downloading', emphasis: 'Dune.2021' },
  avatar: null,
  artwork: { kind: 'notification', id: 'n1', aspect: 'poster', alt: 'Poster', mediaType: 'movie' },
  facts: [{ icon: 'download', label: 'Media', value: 'Dune.2021' }],
  progress: { percent: 42, label: '42%', positionLabel: null },
  status: 'Now Playing',
  action: { label: 'View', href: '/torrents', icon: 'download' },
  timestamp: '2026-07-25T20:00:00Z',
  ...over,
});

describe('email rendering', () => {
  it('puts the headline in the subject', () => {
    expect(renderEmailSubject(presentation())).toBe('Download Complete');
  });

  it('carries the same facts in text and HTML', () => {
    const p = presentation();
    expect(renderEmailText(p)).toContain('Media: Dune.2021');
    expect(renderEmailHtml(p)).toContain('Dune.2021');
  });

  it('inlines styles, since clients strip style blocks', () => {
    const html = renderEmailHtml(presentation());
    expect(html).not.toContain('<style');
    expect(html).toContain('style="');
  });

  it('escapes HTML in every interpolated value', () => {
    const html = renderEmailHtml(presentation({
      facts: [{ icon: 'download', label: 'Media', value: '<img src=x onerror=alert(1)>' }],
      summary: { text: '<b>nope</b>', emphasis: null },
    }));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>nope</b>');
    expect(html).toContain('&lt;img');
  });

  it('omits artwork rather than minting a public URL for it', () => {
    // The presentation carries a REFERENCE; resolving it here would mean either
    // a permanent unauthenticated link or reaching into the media integration.
    const html = renderEmailHtml(presentation());
    expect(html).not.toContain('<img');
    expect(html).not.toContain('http');
  });

  it('renders the progress bar at the stated percentage', () => {
    expect(renderEmailHtml(presentation())).toContain('width:42%');
  });
});

/* ------------------------------------------------------------------ worker */

/** A playback presentation in the shape the new builder emits. */
const playbackPresentation = (over: Partial<NotificationPresentation> = {}): NotificationPresentation => ({
  version: PRESENTATION_VERSION,
  eventKey: 'media_server.user_started_watching',
  accent: 'started', icon: 'play',
  headline: { lead: 'User Started', trail: 'Watching' },
  summary: { text: 'Dennis started watching Dune (2021)', emphasis: 'Dune (2021)' },
  media: { kind: 'movie', primary: 'Dune (2021)', secondary: null },
  context: '4K HDR • Living Room Apple TV',
  avatar: null,
  artwork: { kind: 'notification', id: 'n1', aspect: 'poster', alt: 'Poster', mediaType: 'movie' },
  facts: [], progress: null, status: 'Now Playing',
  action: { label: 'View Live Activity', href: '/media-server-analytics/live', icon: 'monitor' },
  timestamp: '2026-07-26T20:00:00Z',
  ...over,
});

describe('NotificationDeliveryWorker', () => {
  const build = (opts: {
    delivery?: Partial<Record<string, unknown>>;
    active?: boolean;
    destination?: { id: string; address: string } | null;
    telegramBot?: { token: string; botUsername: string; chatId: string | null } | null;
    appUrl?: string;
    artwork?: { body: Buffer; contentType: string } | null;
    presentation?: unknown;
    sendFails?: string;
    photoFails?: string;
  } = {}) => {
    const rows: any[] = [{
      id: 'd1', userId: 'u1', notificationId: 'n1', eventKey: 'torrent.completed',
      channelType: 'email', status: 'pending', attempts: 0, nextAttemptAt: new Date(),
      ...opts.delivery,
    }];
    const prisma: any = {
      userNotificationDelivery: {
        findMany: jest.fn(async () => rows),
        update: jest.fn(async ({ where, data }: any) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return row;
        }),
      },
      user: { findUnique: jest.fn(async () => ({ isActive: opts.active ?? true })) },
      userNotification: {
        findUnique: jest.fn(async () =>
          opts.presentation === null
            ? null
            : { presentation: opts.presentation ?? presentation(), title: 'Done' },
        ),
      },
    };
    const channels: any = {
      resolveDestination: jest.fn(async () =>
        opts.destination === undefined ? { id: 'c1', address: 'a@b.co' } : opts.destination,
      ),
      // The bot belongs to the recipient, so the worker resolves it per delivery.
      resolveTelegramBot: jest.fn(async () =>
        opts.telegramBot === undefined
          ? { token: 'bot-token', botUsername: 'mybot', chatId: '99' }
          : opts.telegramBot,
      ),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };
    const sent: any[] = [];
    const mail: any = {
      send: jest.fn(async (m: any) => {
        if (opts.sendFails) throw new Error(opts.sendFails);
        sent.push(m);
      }),
    };
    const telegramSent: string[] = [];
    const telegramPhotos: any[] = [];
    const telegram: any = {
      sendMessage: jest.fn(async (_token: string, _chat: string, html: string) => {
        if (opts.sendFails) throw new Error(opts.sendFails);
        telegramSent.push(html);
      }),
      sendPhoto: jest.fn(async (_token: string, _chat: string, _photo: any, caption: string) => {
        if (opts.photoFails) throw new Error(opts.photoFails);
        if (opts.sendFails) throw new Error(opts.sendFails);
        telegramPhotos.push({ photo: _photo, caption });
      }),
    };
    // Resolved lazily by the worker for the app URL and for artwork bytes.
    // Throwing is the "not available" path, which must degrade to text-only.
    const moduleRef: any = {
      get: jest.fn((token: any) => {
        const name = token?.name ?? '';
        if (name === 'SettingsService') return { get: async () => opts.appUrl ?? undefined };
        if (name === 'MediaServerSessionService') {
          return { notificationArtwork: async () => opts.artwork ?? null };
        }
        throw new Error(`unexpected ${name}`);
      }),
    };
    const discordSent: any[] = [];
    const discord: any = {
      send: jest.fn(async (_url: string, payload: any) => {
        if (opts.sendFails) throw new Error(opts.sendFails);
        discordSent.push(payload);
      }),
    };
    return {
      worker: new NotificationDeliveryWorker(prisma, channels, mail, telegram, discord, moduleRef),
      rows, sent, telegramSent, telegramPhotos, discordSent, channels, mail, telegram, discord, moduleRef,
    };
  };

  it('sends a due delivery and records provider_accepted, not delivered', async () => {
    const { worker, rows, sent } = build();
    expect(await worker.drain()).toMatchObject({ sent: 1 });
    expect(sent[0]).toMatchObject({ to: 'a@b.co', subject: 'Download Complete' });
    // SMTP acknowledges the relay took it, not that a person received it.
    expect(rows[0].status).toBe('provider_accepted');
  });

  it('cancels rather than sends when the account was deactivated after queueing', async () => {
    const { worker, rows, mail } = build({ active: false });
    expect(await worker.drain()).toMatchObject({ cancelled: 1 });
    expect(mail.send).not.toHaveBeenCalled();
    expect(rows[0].suppressedReason).toBe('user_inactive');
  });

  it('cancels when the channel was disconnected after queueing', async () => {
    const { worker, rows, mail } = build({ destination: null });
    await worker.drain();
    expect(mail.send).not.toHaveBeenCalled();
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].suppressedReason).toBe('no_verified_connection');
  });

  it('cancels when the notification it should render is gone', async () => {
    const { worker, rows } = build({ presentation: null });
    await worker.drain();
    expect(rows[0].suppressedReason).toBe('notification_missing');
  });

  it('backs off on failure and stops after three attempts', async () => {
    const { worker, rows } = build({ sendFails: 'connection refused' });

    await worker.drain();
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(rows[0].nextAttemptAt).toBeInstanceOf(Date);

    rows[0].nextAttemptAt = new Date(0);
    await worker.drain();
    expect(rows[0].attempts).toBe(2);

    rows[0].nextAttemptAt = new Date(0);
    await worker.drain();
    expect(rows[0].attempts).toBe(3);
    // Exhausted: no further attempt is scheduled.
    expect(rows[0].nextAttemptAt).toBeNull();
    expect(rows[0].completedAt).toBeInstanceOf(Date);
  });

  it('records the failure against the channel so its health degrades', async () => {
    const { worker, channels } = build({ sendFails: 'refused' });
    await worker.drain();
    expect(channels.recordFailure).toHaveBeenCalledWith('u1', 'email', 'refused');
  });

  it('sends Telegram through the bot, not the mail relay', async () => {
    const { worker, rows, telegramSent, mail, telegram } = build({ delivery: { channelType: 'telegram' } });
    expect(await worker.drain()).toMatchObject({ sent: 1 });
    expect(mail.send).not.toHaveBeenCalled();
    expect(telegramSent[0]).toContain('<b>Download Complete</b>');
    // Sent with THIS recipient's bot token, not a platform-wide one.
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      'bot-token', 'a@b.co', expect.any(String), null,
    );
    expect(rows[0].status).toBe('provider_accepted');
  });

  it('cancels a Telegram delivery when the recipient no longer has a bot', async () => {
    // Re-checked at send time like every other precondition: a user can replace
    // or disconnect their bot between queueing and sending. Cancelled rather
    // than retried — retrying cannot conjure a credential back.
    const { worker, rows, telegramSent } = build({
      delivery: { channelType: 'telegram' },
      telegramBot: null,
    });
    expect(await worker.drain()).toMatchObject({ sent: 0 });
    expect(telegramSent).toHaveLength(0);
    expect(rows[0].status).toBe('cancelled');
  });

  it('uploads artwork as a photo when the presentation carries a reference', async () => {
    // A real PNG header — the worker sniffs magic bytes, not the declared type.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64),
    ]);
    const { worker, telegram, telegramPhotos } = build({
      delivery: { channelType: 'telegram' },
      presentation: playbackPresentation(),
      artwork: { body: png, contentType: 'image/png' },
      appUrl: 'https://ultra.example.com',
    });
    expect(await worker.drain()).toMatchObject({ sent: 1 });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegramPhotos).toHaveLength(1);
    expect(telegramPhotos[0].photo.contentType).toBe('image/png');
    // A fixed name — the provider-internal path must never travel to Telegram.
    expect(telegramPhotos[0].photo.filename).toBe('poster.png');
  });

  it('falls back to text when the photo upload fails', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64),
    ]);
    const { worker, rows, telegram, telegramSent } = build({
      delivery: { channelType: 'telegram' },
      presentation: playbackPresentation(),
      artwork: { body: png, contentType: 'image/png' },
      photoFails: 'PHOTO_INVALID_DIMENSIONS',
    });
    // The words matter more than the picture: still delivered, not retried.
    expect(await worker.drain()).toMatchObject({ sent: 1 });
    expect(telegram.sendMessage).toHaveBeenCalled();
    expect(telegramSent[0]).toContain('Dennis started watching');
    expect(rows[0].status).toBe('provider_accepted');
  });

  it('sends text-only when the artwork is not a real image', async () => {
    // An HTML error page served with an image content-type is the realistic case.
    const { worker, telegram, telegramPhotos } = build({
      delivery: { channelType: 'telegram' },
      presentation: playbackPresentation(),
      artwork: { body: Buffer.from('<html>404</html>'), contentType: 'image/png' },
    });
    expect(await worker.drain()).toMatchObject({ sent: 1 });
    expect(telegramPhotos).toHaveLength(0);
    expect(telegram.sendMessage).toHaveBeenCalled();
  });

  it('omits the button when no public app URL is configured', async () => {
    const { worker, telegram } = build({
      delivery: { channelType: 'telegram' },
      presentation: playbackPresentation(),
    });
    await worker.drain();
    // A link to nowhere reads as a broken notification, so there is no link.
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      'bot-token', 'a@b.co', expect.any(String), null,
    );
  });

  it('builds exactly one absolute button when the app URL is set', async () => {
    const { worker, telegram } = build({
      delivery: { channelType: 'telegram' },
      presentation: playbackPresentation(),
      appUrl: 'https://ultra.example.com/',
    });
    await worker.drain();
    const button = (telegram.sendMessage as jest.Mock).mock.calls[0][3];
    expect(button).toEqual({
      text: 'View Live Activity',
      url: 'https://ultra.example.com/media-server-analytics/live',
    });
  });

  it('sends Discord as an embed, with mentions disabled', async () => {
    const { worker, rows, discordSent, mail } = build({ delivery: { channelType: 'discord' } });
    expect(await worker.drain()).toMatchObject({ sent: 1 });
    expect(mail.send).not.toHaveBeenCalled();
    expect(discordSent[0]).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(discordSent[0].embeds[0].title).toBe('Download Complete');
    expect(rows[0].status).toBe('provider_accepted');
  });

  it('cancels a Discord delivery with no rich presentation rather than sending a bare title', async () => {
    // An embed needs structure; a bare title would look broken beside real cards.
    const { worker, rows, discord } = build({
      delivery: { channelType: 'discord' }, presentation: { nonsense: true },
    });
    await worker.drain();
    expect(discord.send).not.toHaveBeenCalled();
    expect(rows[0].suppressedReason).toBe('no_presentation');
  });

  it('cancels an unknown channel instead of retrying it three times', async () => {
    const { worker, rows, mail, telegram, discord } = build({ delivery: { channelType: 'sms' } });
    await worker.drain();
    expect(mail.send).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(discord.send).not.toHaveBeenCalled();
    expect(rows[0].suppressedReason).toBe('channel_not_implemented');
  });

  it('falls back to the plain title when no rich presentation was stored', async () => {
    const { worker, sent } = build({ presentation: { nonsense: true } });
    await worker.drain();
    expect(sent[0].subject).toBe('Done');
  });
});
