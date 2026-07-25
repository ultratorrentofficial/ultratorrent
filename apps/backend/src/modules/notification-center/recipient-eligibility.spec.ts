import { ForbiddenException } from '@nestjs/common';
import { NotificationRecipientEligibilityService } from './recipient-eligibility.service';
import {
  NOTIFICATION_CHANNEL_TYPES,
  requiresConnection,
  SEVERITY_RANK,
  TERMINAL_DELIVERY_STATUSES,
} from '@ultratorrent/shared';

/**
 * Local accounts live in `users`; external identities (Plex/Jellyfin/Emby viewers)
 * live in `media_server_users` and are simply absent from the table the service
 * queries. The stub models exactly that separation — an external id resolves to
 * nothing, which is why "fail closed" is the whole design.
 */
function build(users: Array<{ id: string; isActive: boolean }>) {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => users.find((u) => u.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        users.filter((u) => where.id.in.includes(u.id) && (where.isActive === undefined || u.isActive === where.isActive)),
      ),
    },
  };
  return { svc: new NotificationRecipientEligibilityService(prisma as any), prisma };
}

const LOCAL = { id: 'local-1', isActive: true };
const DISABLED = { id: 'local-off', isActive: false };

describe('NotificationRecipientEligibilityService', () => {
  it('accepts an active local user', async () => {
    const { svc } = build([LOCAL]);
    await expect(svc.isEligible('local-1')).resolves.toBe(true);
  });

  it('rejects a deactivated local user', async () => {
    const { svc } = build([DISABLED]);
    expect(await svc.check('local-off')).toMatchObject({ eligible: false, reason: 'inactive' });
  });

  it('rejects a deleted user (row gone)', async () => {
    const { svc } = build([]);
    expect(await svc.check('was-deleted')).toMatchObject({ eligible: false, reason: 'not_found' });
  });

  describe('external identities are never eligible', () => {
    // Each of these is an id from a DIFFERENT identity namespace. None can
    // authenticate into UltraTorrent, so none may own a notification.
    const externals = [
      ['Plex viewer (media_server_users)', 'plex-user-88213'],
      ['Jellyfin viewer', 'jf-3f9c1a44'],
      ['Emby viewer', 'emby-77120'],
      ['Trakt identity', 'trakt-dennis'],
      ['imported playback user', 'import-living-room'],
      ['service identity', 'svc-worker-01'],
      ['API client', 'apikey-9f2b'],
    ];
    for (const [label, id] of externals) {
      it(`rejects ${label}`, async () => {
        const { svc } = build([LOCAL]);
        expect(await svc.check(id)).toMatchObject({ eligible: false, reason: 'not_found' });
      });
    }

    it('does NOT resolve an external identity by matching email or username', async () => {
      // A Plex account legitimately carries the same email as the operator's real
      // account. Matching on it would hand notifications to a viewer who cannot log
      // in — the identity-confusion defect this engine exists to remove. The service
      // only ever looks up by primary key.
      const { svc, prisma } = build([LOCAL]);
      await svc.check('dennis.ayala@gmail.com');
      const lookups = prisma.user.findUnique.mock.calls.map((c: any) => c[0].where);
      expect(lookups.every((w: any) => 'id' in w && !('email' in w) && !('username' in w))).toBe(true);
    });
  });

  it('rejects empty, null and undefined without hitting the database', async () => {
    const { svc, prisma } = build([LOCAL]);
    for (const bad of [null, undefined, '', '   ']) {
      expect(await svc.check(bad)).toMatchObject({ eligible: false, reason: 'not_found' });
    }
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  describe('filterEligible', () => {
    it('keeps only active local users and drops external ids', async () => {
      const { svc } = build([LOCAL, DISABLED]);
      expect(await svc.filterEligible(['local-1', 'local-off', 'plex-user-88213', null])).toEqual(['local-1']);
    });

    it('deduplicates, so one person resolved twice is notified once', async () => {
      // e.g. the same user is both the actor AND the resource owner.
      const { svc } = build([LOCAL]);
      expect(await svc.filterEligible(['local-1', 'local-1', ' local-1 '])).toEqual(['local-1']);
    });

    it('resolves the whole candidate set in ONE query (no N+1 on the hot path)', async () => {
      const { svc, prisma } = build([LOCAL]);
      await svc.filterEligible(['local-1', 'a', 'b', 'c', 'd']);
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('short-circuits an empty candidate set', async () => {
      const { svc, prisma } = build([LOCAL]);
      expect(await svc.filterEligible([null, undefined, ''])).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('assertEligible (delivery + retry boundary)', () => {
    it('returns the id for an eligible user', async () => {
      const { svc } = build([LOCAL]);
      await expect(svc.assertEligible('local-1')).resolves.toBe('local-1');
    });

    it('throws once an account is deactivated between queueing and retry', async () => {
      const { svc } = build([DISABLED]);
      await expect(svc.assertEligible('local-off')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws for an external identity', async () => {
      const { svc } = build([LOCAL]);
      await expect(svc.assertEligible('plex-user-88213')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assertOwnership (cross-user access)', () => {
    it('allows a user to reach their own resource', () => {
      const { svc } = build([LOCAL]);
      expect(() => svc.assertOwnership('local-1', 'local-1')).not.toThrow();
    });

    it("refuses another user's resource", () => {
      const { svc } = build([LOCAL]);
      expect(() => svc.assertOwnership('local-1', 'local-2')).toThrow(ForbiddenException);
    });

    it('refuses an unowned resource', () => {
      const { svc } = build([LOCAL]);
      expect(() => svc.assertOwnership('local-1', null)).toThrow(ForbiddenException);
    });

    it("does not reveal whether the other user's resource exists", () => {
      // Same message for "not yours" and "no such thing" — a different one would
      // confirm the existence of another user's object.
      const { svc } = build([LOCAL]);
      const a = (() => { try { svc.assertOwnership('local-1', 'local-2'); } catch (e) { return (e as Error).message; } })();
      const b = (() => { try { svc.assertOwnership('local-1', null); } catch (e) { return (e as Error).message; } })();
      expect(a).toBe(b);
    });
  });
});

describe('shared notification-engine contracts', () => {
  it('offers in-app plus the four connection-backed channels, and no sms', () => {
    expect([...NOTIFICATION_CHANNEL_TYPES]).toEqual(['in_app', 'email', 'telegram', 'whatsapp', 'discord']);
    expect(NOTIFICATION_CHANNEL_TYPES as readonly string[]).not.toContain('sms');
    // Slack / generic webhooks address an endpoint, not a person — they stay
    // integration messages and must never appear as a personal channel.
    expect(NOTIFICATION_CHANNEL_TYPES as readonly string[]).not.toContain('slack');
    expect(NOTIFICATION_CHANNEL_TYPES as readonly string[]).not.toContain('webhook');
  });

  it('requires a stored connection for every channel except in-app', () => {
    expect(requiresConnection('in_app')).toBe(false);
    for (const t of ['email', 'telegram', 'whatsapp', 'discord'] as const) {
      expect(requiresConnection(t)).toBe(true);
    }
  });

  it('ranks severity so a minSeverity filter is a comparison', () => {
    expect(SEVERITY_RANK.security).toBeGreaterThan(SEVERITY_RANK.critical);
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.error);
    expect(SEVERITY_RANK.info).toBe(0);
  });

  it('does not treat provider acceptance as final delivery', () => {
    // Most providers acknowledge acceptance, not receipt. Calling that "delivered"
    // would make the history lie about what actually reached the person.
    expect(TERMINAL_DELIVERY_STATUSES).toContain('delivered');
    expect(TERMINAL_DELIVERY_STATUSES).not.toContain('provider_accepted');
    expect(TERMINAL_DELIVERY_STATUSES).not.toContain('sent_to_provider');
    expect(TERMINAL_DELIVERY_STATUSES).not.toContain('retry_scheduled');
  });
});
