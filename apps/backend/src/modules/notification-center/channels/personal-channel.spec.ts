import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  maskEmail, maskPhone, maskWebhook, normalizeE164,
  validateDiscordWebhook, validatePersonalChannelConfig,
} from './personal-channel-validators';
import { PersonalChannelService } from './personal-channel.service';

describe('Discord webhook validation (SSRF)', () => {
  it('accepts a real Discord webhook', () => {
    expect(validateDiscordWebhook('https://discord.com/api/webhooks/123/abc').ok).toBe(true);
    expect(validateDiscordWebhook('https://discordapp.com/api/webhooks/123/abc').ok).toBe(true);
  });

  describe('refuses hosts that would make the server a request-forgery tool', () => {
    // The server fetches this URL, so an unrestricted one reaches anything the
    // container can: cloud metadata, the database, other internal services.
    const attacks: Array<[string, string]> = [
      ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
      ['loopback', 'https://127.0.0.1/api/webhooks/1/x'],
      ['localhost by name', 'https://localhost/api/webhooks/1/x'],
      ['private network', 'https://10.0.0.5/api/webhooks/1/x'],
      ['internal service name', 'https://postgres:5432/api/webhooks/1/x'],
      ['attacker domain', 'https://evil.example.com/api/webhooks/1/x'],
      ['lookalike subdomain', 'https://discord.com.evil.example/api/webhooks/1/x'],
    ];
    for (const [label, url] of attacks) {
      it(`refuses ${label}`, () => {
        expect(validateDiscordWebhook(url)).toMatchObject({ ok: false, reason: 'host_not_allowed' });
      });
    }
  });

  it('refuses plain HTTP, which would send the credential in clear', () => {
    expect(validateDiscordWebhook('http://discord.com/api/webhooks/1/x')).toMatchObject({
      ok: false, reason: 'https_required',
    });
  });

  it('refuses a Discord URL that is not a webhook path', () => {
    expect(validateDiscordWebhook('https://discord.com/api/users/@me')).toMatchObject({
      ok: false, reason: 'not_a_webhook_path',
    });
  });

  it('refuses a malformed URL', () => {
    expect(validateDiscordWebhook('not a url')).toMatchObject({ ok: false, reason: 'invalid_url' });
  });
});

describe('destination normalization and masking', () => {
  it('normalizes a phone to E.164, tolerating punctuation', () => {
    expect(normalizeE164(' +1 (787) 555-1234 ')).toMatchObject({ ok: true, phone: '+17875551234' });
  });

  it('refuses a number with no country code rather than guessing one', () => {
    // Guessing a country would silently message a stranger.
    expect(normalizeE164('7875551234')).toMatchObject({ ok: false, reason: 'country_code_required' });
  });

  it('refuses an implausible length', () => {
    expect(normalizeE164('+123').ok).toBe(false);
  });

  it('masks destinations so a listing never shows the raw value', () => {
    expect(maskEmail('dennis.ayala@gmail.com')).toBe('d•••a@gmail.com');
    expect(maskPhone('+17875551234')).toBe('+1787•••1234');
    expect(maskWebhook('https://discord.com/api/webhooks/123/supersecret')).toBe('discord.com/…');
  });

  it('never leaks the webhook token through the mask', () => {
    expect(maskWebhook('https://discord.com/api/webhooks/123/supersecret')).not.toContain('supersecret');
  });

  it('lowercases and validates an email', () => {
    expect(validatePersonalChannelConfig('email', { address: 'A@B.CO' })).toMatchObject({
      valid: true, config: { address: 'a@b.co' },
    });
    expect(validatePersonalChannelConfig('email', { address: 'nope' }).valid).toBe(false);
  });

  it('refuses a Telegram config with no linked chat', () => {
    expect(validatePersonalChannelConfig('telegram', {})).toMatchObject({ valid: false, reason: 'link_required' });
  });
});

/** In-memory Prisma + a reversible fake cipher, so encryption is observable. */
function build(rows: any[] = []) {
  let seq = 0;
  const prisma = {
    userNotificationChannel: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => r.userId === where.userId && r.deletedAt === null),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        rows.find((r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.userId?.not ? r.userId !== where.userId.not : where.userId === undefined || r.userId === where.userId) &&
          (where.type === undefined || r.type === where.type) &&
          r.deletedAt === null,
        ) ?? null,
      ),
      count: jest.fn(async ({ where }: any) =>
        rows.filter((r) => r.userId === where.userId && r.type === where.type && r.deletedAt === null).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `ch-${++seq}`, enabled: true, isDefault: false, verifiedAt: null, lastTestedAt: null,
          lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, disabledReason: null,
          destinationMask: null, deletedAt: null, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        for (const [k, v] of Object.entries<any>(data)) {
          row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] ?? 0) + v.increment : v;
        }
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        for (const r of rows) if (r.userId === where.userId && r.type === where.type && r.deletedAt === null) Object.assign(r, data);
        return { count: 0 };
      }),
    },
    userNotificationEventRoute: { deleteMany: jest.fn(async () => ({ count: 2 })) },
  };
  const cipher = {
    encrypt: jest.fn((s: string) => `enc:${s}`),
    decrypt: jest.fn((s: string) => { if (!s.startsWith('enc:')) throw new Error('bad'); return s.slice(4); }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  // Typed loosely on purpose: tests override it with failure shapes carrying an
  // errorClass, which a narrowly-inferred mock would reject.
  const transmitter = {
    transmit: jest.fn<Promise<Record<string, unknown>>, unknown[]>(async () => ({ ok: true, accepted: true })),
  };
  return {
    svc: new PersonalChannelService(prisma as any, audit as any, cipher as any, transmitter as any),
    rows, cipher, audit, transmitter,
  };
}

describe('PersonalChannelService', () => {
  it('encrypts the destination and never returns it', async () => {
    const { svc, rows, cipher } = build();
    const view = await svc.create('me', { type: 'email', name: 'Work', config: { address: 'dennis@gmail.com' } });
    expect(cipher.encrypt).toHaveBeenCalledWith('dennis@gmail.com');
    expect(rows[0].encryptedConfig).toEqual({ address: 'enc:dennis@gmail.com' });
    // The view carries only the mask — the raw address never leaves the server.
    expect(JSON.stringify(view)).not.toContain('dennis@gmail.com');
    expect(view.destinationMask).toBe('d•••s@gmail.com');
  });

  it('starts unverified, so delivery cannot target an unproven address', async () => {
    const { svc } = build();
    const v = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
    expect(v.verified).toBe(false);
    expect(v.health).toBe('unverified');
  });

  it('makes the first connection of a type the default', async () => {
    const { svc } = build();
    const first = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
    const second = await svc.create('me', { type: 'email', config: { address: 'c@d.co' } });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
  });

  it('supports several connections of the same type', async () => {
    const { svc } = build();
    await svc.create('me', { type: 'email', config: { address: 'work@x.co' } });
    await svc.create('me', { type: 'email', config: { address: 'home@x.co' } });
    expect(await svc.list('me')).toHaveLength(2);
  });

  it('refuses to create a Telegram connection directly', async () => {
    // A chat id from the client could point at somebody else's chat.
    const { svc } = build();
    await expect(svc.create('me', { type: 'telegram', config: { chatId: '12345' } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a Discord webhook aimed at an internal host', async () => {
    const { svc } = build();
    await expect(
      svc.create('me', { type: 'discord', config: { webhookUrl: 'https://169.254.169.254/api/webhooks/1/x' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('ownership', () => {
    it("refuses another user's connection as NOT FOUND", async () => {
      const { svc, rows } = build();
      await svc.create('other', { type: 'email', config: { address: 'a@b.co' } });
      await expect(svc.get('me', rows[0].id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to reveal config for a connection you do not own', async () => {
      const { svc, rows } = build();
      await svc.create('other', { type: 'email', config: { address: 'a@b.co' } });
      await expect(svc.revealConfig('me', rows[0].id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('decrypts config for the owner', async () => {
      const { svc, rows } = build();
      await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
      expect(await svc.revealConfig('me', rows[0].id)).toEqual({ address: 'a@b.co' });
    });

    it('treats undecryptable config as unusable rather than delivering to garbage', async () => {
      const { svc, rows } = build();
      await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
      rows[0].encryptedConfig = { address: 'not-encrypted' }; // e.g. rotated key
      await expect(svc.revealConfig('me', rows[0].id)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('derives health from state', async () => {
    const { svc, rows } = build();
    const v = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
    expect((await svc.markVerified('me', v.id)).health).toBe('healthy');
    rows[0].consecutiveFailures = 1;
    expect((await svc.get('me', v.id)).health).toBe('degraded');
    rows[0].consecutiveFailures = 3;
    expect((await svc.get('me', v.id)).health).toBe('failing');
    await svc.setEnabled('me', v.id, false);
    expect((await svc.get('me', v.id)).health).toBe('disabled');
  });

  it('revokes by soft delete and removes routes pointing at it', async () => {
    // History references the connection; hard delete would orphan or erase it.
    const { svc, rows } = build();
    const v = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
    const r = await svc.remove('me', v.id);
    expect(r.routesRemoved).toBe(2);
    expect(rows[0].deletedAt).toBeInstanceOf(Date);
    await expect(svc.get('me', v.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('Telegram linking', () => {
    it('binds a chat and marks it verified by the round trip', async () => {
      const { svc } = build();
      const { code } = await svc.startTelegramLink('me', 'My Telegram');
      const v = await svc.confirmTelegramLink(code, '99887766');
      expect(v.type).toBe('telegram');
      expect(v.verified).toBe(true);
      expect(v.destinationMask).toBe('•••7766');
    });

    it('consumes the code, so a replay cannot bind a second chat', async () => {
      const { svc } = build();
      const { code } = await svc.startTelegramLink('me', 'T');
      await svc.confirmTelegramLink(code, '111');
      await expect(svc.confirmTelegramLink(code, '222')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown code', async () => {
      const { svc } = build();
      await expect(svc.confirmTelegramLink('DEADBEEF', '111')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a chat already linked to a DIFFERENT account', async () => {
      // Silently re-pointing it would divert that person's notifications.
      const { svc } = build();
      const a = await svc.startTelegramLink('user-a', 'A');
      await svc.confirmTelegramLink(a.code, 'shared-chat');
      const b = await svc.startTelegramLink('user-b', 'B');
      await expect(svc.confirmTelegramLink(b.code, 'shared-chat')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not store the code in a usable form', async () => {
      const { svc } = build();
      const { code } = await svc.startTelegramLink('me', 'T');
      const stored = JSON.stringify([...(svc as any).pendingLinks.values()]);
      expect(stored).not.toContain(code);
    });
  });

  describe('test / verify', () => {
    it('VERIFIES on a successful round trip — the only way verification is granted', async () => {
      // Asserting ownership of an address would make the flag meaningless.
      const { svc } = build();
      const v = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
      expect(v.verified).toBe(false);
      const r = await svc.test('me', v.id);
      expect(r).toMatchObject({ ok: true, verified: true });
      expect((await svc.get('me', v.id)).health).toBe('healthy');
    });

    it('records a failure without verifying', async () => {
      const { svc, transmitter } = build();
      transmitter.transmit.mockResolvedValue({ ok: false, errorClass: 'invalid_destination', error: 'HTTP 404' });
      const v = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
      const r = await svc.test('me', v.id);
      expect(r).toMatchObject({ ok: false, verified: false, error: 'invalid_destination' });
      expect((await svc.get('me', v.id)).consecutiveFailures).toBe(1);
    });

    it('does NOT revoke an existing verification on one failed test', async () => {
      // One bad night does not mean the address stopped being theirs.
      const { svc, transmitter } = build();
      const v = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
      await svc.test('me', v.id); // verifies
      transmitter.transmit.mockResolvedValue({ ok: false, errorClass: 'timeout', error: 'timed out' });
      const r = await svc.test('me', v.id);
      expect(r.verified).toBe(true);
      expect((await svc.get('me', v.id)).verified).toBe(true);
    });

    it('stores the classified reason, never the provider body', async () => {
      // A provider body can echo the request, which for a webhook means the credential.
      const { svc, transmitter, rows } = build();
      transmitter.transmit.mockResolvedValue({
        ok: false, errorClass: 'invalid_credentials', error: 'HTTP 401 token=SECRET',
      });
      const v = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
      await svc.test('me', v.id);
      expect(rows[0].disabledReason).toBe('invalid_credentials');
      expect(JSON.stringify(rows[0])).not.toContain('SECRET');
    });

    it("refuses to test another user's connection", async () => {
      const { svc, rows, transmitter } = build();
      await svc.create('other', { type: 'email', config: { address: 'a@b.co' } });
      await expect(svc.test('me', rows[0].id)).rejects.toBeInstanceOf(NotFoundException);
      expect(transmitter.transmit).not.toHaveBeenCalled();
    });
  });

  it('keeps exactly one default per type', async () => {
    const { svc } = build();
    const a = await svc.create('me', { type: 'email', config: { address: 'a@b.co' } });
    const b = await svc.create('me', { type: 'email', config: { address: 'c@d.co' } });
    await svc.makeDefault('me', b.id);
    const list = await svc.list('me');
    expect(list.filter((c) => c.isDefault).map((c) => c.id)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });
});
