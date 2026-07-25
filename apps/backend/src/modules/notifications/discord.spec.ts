import { BadRequestException } from '@nestjs/common';
import { PRESENTATION_VERSION, type NotificationPresentation } from '@ultratorrent/shared';
import {
  maskDiscordWebhook,
  parseDiscordWebhook,
  stripMentions,
} from './channels/discord-validators';
import { NotificationChannelService } from './channels/notification-channel.service';
import { renderDiscord } from './providers/discord-renderer';

const VALID = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-_123';

/* --------------------------------------------------------------------- SSRF */

describe('Discord webhook validation', () => {
  it('accepts every legitimate Discord host', () => {
    for (const host of ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']) {
      const out = parseDiscordWebhook(`https://${host}/api/webhooks/123456789012345678/tok-en_1`);
      expect(out.url).toContain(host);
    }
  });

  it('accepts a versioned API path', () => {
    expect(() => parseDiscordWebhook('https://discord.com/api/v10/webhooks/123/tok')).not.toThrow();
  });

  it('refuses any host that is not Discord', () => {
    for (const bad of [
      'https://evil.example/api/webhooks/123/tok',
      // The classic SSRF targets — cloud metadata and loopback.
      'https://169.254.169.254/api/webhooks/123/tok',
      'https://127.0.0.1/api/webhooks/123/tok',
      'https://localhost/api/webhooks/123/tok',
      'https://[::1]/api/webhooks/123/tok',
      'https://10.0.0.5/api/webhooks/123/tok',
    ]) {
      expect(() => parseDiscordWebhook(bad)).toThrow(BadRequestException);
    }
  });

  it('refuses a lookalike host that merely contains the allowed name', () => {
    // `discord.com.evil.example` and `notdiscord.com` both pass a naive
    // substring check and must not pass this one.
    for (const bad of [
      'https://discord.com.evil.example/api/webhooks/123/tok',
      'https://notdiscord.com/api/webhooks/123/tok',
      'https://evil.example/discord.com/api/webhooks/123/tok',
    ]) {
      expect(() => parseDiscordWebhook(bad)).toThrow(BadRequestException);
    }
  });

  it('refuses plaintext, which would send the token in the clear', () => {
    expect(() => parseDiscordWebhook('http://discord.com/api/webhooks/123/tok')).toThrow(BadRequestException);
  });

  it('refuses embedded credentials, which would be forwarded on every send', () => {
    expect(() => parseDiscordWebhook('https://user:pass@discord.com/api/webhooks/123/tok'))
      .toThrow(BadRequestException);
  });

  it('refuses a non-standard port', () => {
    expect(() => parseDiscordWebhook('https://discord.com:8443/api/webhooks/123/tok'))
      .toThrow(BadRequestException);
  });

  it('refuses a Discord URL that is not a webhook path', () => {
    for (const bad of [
      'https://discord.com/api/users/@me',
      'https://discord.com/',
      'https://discord.com/api/webhooks/',
    ]) {
      expect(() => parseDiscordWebhook(bad)).toThrow(BadRequestException);
    }
  });

  it('refuses nonsense rather than storing it', () => {
    for (const bad of ['', '   ', 'not a url', 'ftp://discord.com/api/webhooks/1/t']) {
      expect(() => parseDiscordWebhook(bad)).toThrow(BadRequestException);
    }
  });

  it('normalises the URL, dropping any query or fragment a user pasted', () => {
    const out = parseDiscordWebhook(`${VALID}?wait=true#frag`);
    expect(out.url).toBe(VALID);
    expect(out.url).not.toContain('?');
    expect(out.url).not.toContain('#');
  });

  it('extracts the webhook id for display', () => {
    expect(parseDiscordWebhook(VALID).webhookId).toBe('123456789012345678');
  });
});

describe('Discord masking', () => {
  it('never shows the token, even partially', () => {
    const masked = maskDiscordWebhook('123456789012345678', 'alerts');
    expect(masked).toBe('#alerts (…5678)');
    expect(masked).not.toContain('abcDEF');
  });

  it('falls back to an id suffix when the channel name is unknown', () => {
    expect(maskDiscordWebhook('123456789012345678', null)).toBe('Webhook …5678');
  });
});

describe('mention stripping', () => {
  it('neutralises @everyone and @here in any case', () => {
    const out = stripMentions('hey @everyone and @HERE and @Everyone');
    expect(out).not.toMatch(/(?<!​)@everyone/i);
    expect(out).not.toMatch(/(?<!​)@here/i);
  });

  it('neutralises role and user mentions', () => {
    expect(stripMentions('<@&1234>')).not.toBe('<@&1234>');
    expect(stripMentions('<@!99>')).not.toBe('<@!99>');
  });

  it('leaves ordinary text alone', () => {
    expect(stripMentions('Dune (2021) — a film about sand')).toBe('Dune (2021) — a film about sand');
  });
});

/* ------------------------------------------------------------------ channel */

describe('Discord channel connection', () => {
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
          store.filter((r) => (!where.userId || r.userId === where.userId) && r.deletedAt === null),
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
          if (existing) { Object.assign(existing, update); return existing; }
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

  it('encrypts the webhook and shows only a mask', async () => {
    const { svc, store } = build();
    const view = await svc.connectDiscord('u1', VALID, 'alerts');
    expect(store[0].encryptedConfig.webhookUrl).toBe(`enc:${VALID}`);
    expect(view.maskedDestination).toBe('#alerts (…5678)');
    // The token must not appear anywhere in what the API returns.
    expect(JSON.stringify(view)).not.toContain('abcDEF');
  });

  it('refuses to store a URL that would be refused at send time', async () => {
    const { svc, store } = build();
    await expect(svc.connectDiscord('u1', 'https://evil.example/api/webhooks/1/t', null))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(store).toHaveLength(0);
  });

  it('stores a new webhook UNVERIFIED', async () => {
    const { svc } = build();
    expect((await svc.connectDiscord('u1', VALID, 'alerts')).verified).toBe(false);
  });

  it('resets verification when the webhook is replaced', async () => {
    const { svc } = build();
    await svc.connectDiscord('u1', VALID, 'alerts');
    await svc.markVerified('u1', 'discord');
    const replaced = await svc.connectDiscord(
      'u1', 'https://discord.com/api/webhooks/987654321098765432/xyz', 'other',
    );
    // A revoked webhook must not inherit a working one's trust.
    expect(replaced.verified).toBe(false);
  });

  it('resolves the decrypted URL only for the delivery path', async () => {
    const { svc } = build();
    await svc.connectDiscord('u1', VALID, 'alerts');
    expect(await svc.resolveDestination('u1', 'discord')).toBeNull(); // unverified
    await svc.markVerified('u1', 'discord');
    expect(await svc.resolveDestination('u1', 'discord')).toMatchObject({ address: VALID });
  });
});

/* ----------------------------------------------------------------- renderer */

const presentation = (over: Partial<NotificationPresentation> = {}): NotificationPresentation => ({
  version: PRESENTATION_VERSION,
  eventKey: 'media_server.user_stopped_watching',
  accent: 'stopped',
  icon: 'stop',
  headline: { lead: 'User Stopped', trail: 'Watching' },
  summary: { text: 'Dennis stopped watching The Last of Us - S01E03', emphasis: 'The Last of Us - S01E03' },
  avatar: null,
  artwork: { kind: 'notification', id: 'n1', aspect: 'poster', alt: 'Poster', mediaType: 'episode' },
  facts: [{ icon: 'user', label: 'User', value: 'Dennis' }],
  progress: { percent: 42, label: '42% watched', positionLabel: null },
  status: '42% watched',
  action: { label: 'View', href: '/x', icon: 'activity' },
  timestamp: '2026-07-25T20:00:00Z',
  ...over,
});

describe('Discord rendering', () => {
  const embedOf = (p: NotificationPresentation) =>
    (renderDiscord(p) as any).embeds[0];

  it('carries the accent as the embed stripe colour', () => {
    expect(embedOf(presentation()).color).toBe(0xf43f5e); // stopped
    expect(embedOf(presentation({ accent: 'started' })).color).toBe(0x22c55e);
  });

  it('keeps stopped visually distinct from error', () => {
    expect(embedOf(presentation({ accent: 'stopped' })).color)
      .not.toBe(embedOf(presentation({ accent: 'error' })).color);
  });

  it('maps facts to inline embed fields', () => {
    const embed = embedOf(presentation());
    expect(embed.fields).toHaveLength(1);
    expect(embed.fields[0]).toMatchObject({ name: 'User', inline: true });
  });

  it('always disables mention resolution', () => {
    // The authoritative protection: Discord resolves nothing at all.
    expect(renderDiscord(presentation())).toMatchObject({ allowed_mentions: { parse: [] } });
  });

  it('neutralises @everyone in a media title as well', () => {
    const embed = embedOf(presentation({
      summary: { text: 'Dennis watched @everyone', emphasis: null },
    }));
    expect(embed.description).not.toMatch(/(?<!​)@everyone/);
  });

  it('escapes markdown so a title cannot inject a masked link', () => {
    const embed = embedOf(presentation({
      summary: { text: 'Dennis watched [click](https://evil.example)', emphasis: null },
    }));
    expect(embed.description).toContain('\\[click\\]');
  });

  it('omits artwork rather than publishing a URL for it', () => {
    const embed = embedOf(presentation());
    expect(embed.thumbnail).toBeUndefined();
    expect(embed.image).toBeUndefined();
    expect(JSON.stringify(embed)).not.toContain('http');
  });

  it('clamps to Discord’s documented limits', () => {
    const embed = embedOf(presentation({
      summary: { text: 'x'.repeat(9000), emphasis: null },
      facts: [{ icon: 'user', label: 'y'.repeat(500), value: 'z'.repeat(3000) }],
    }));
    expect(Array.from(embed.description).length).toBeLessThanOrEqual(4096);
    expect(Array.from(embed.fields[0].name).length).toBeLessThanOrEqual(256);
    expect(Array.from(embed.fields[0].value).length).toBeLessThanOrEqual(1024);
  });

  it('caps fields at Discord’s maximum of 25', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      icon: 'user' as const, label: `l${i}`, value: `v${i}`,
    }));
    expect(embedOf(presentation({ facts: many })).fields).toHaveLength(25);
  });
});
