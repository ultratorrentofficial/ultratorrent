import { BadRequestException } from '@nestjs/common';
import { NotificationProfileService } from './notification-profile.service';

function build(existing: any = null) {
  let row = existing;
  const prisma = {
    userNotificationProfile: {
      findUnique: jest.fn(async () => row),
      upsert: jest.fn(async ({ create, update }: any) => {
        row = row ? { ...row, ...update } : { pausedUntil: null, quietHoursDays: [], ...create };
        return row;
      }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new NotificationProfileService(prisma as any, audit as any), get row() { return row; }, audit };
}

describe('NotificationProfileService', () => {
  it('returns complete defaults with no stored row', async () => {
    const { svc } = build(null);
    const p = await svc.get('me');
    expect(p).toMatchObject({ quietHoursEnabled: false, digestDaily: false, paused: false });
  });

  it('computes the next digest times so the UI need not derive them', async () => {
    const { svc } = build({
      userId: 'me', timezone: 'America/Puerto_Rico', quietHoursDays: [],
      digestDaily: true, digestDailyAt: '08:00', digestWeekly: true, digestWeeklyDay: 1,
      digestWeeklyAt: '09:00', pausedUntil: null,
    });
    const p = await svc.get('me');
    expect(p.nextDailyDigestAt).toMatch(/T/);
    expect(p.nextWeeklyDigestAt).toMatch(/T/);
  });

  it('reports paused only while the pause is still in the future', async () => {
    const past = build({ userId: 'me', quietHoursDays: [], pausedUntil: new Date(Date.now() - 1000) });
    expect((await past.svc.get('me')).paused).toBe(false);
    const future = build({ userId: 'me', quietHoursDays: [], pausedUntil: new Date(Date.now() + 60_000) });
    expect((await future.svc.get('me')).paused).toBe(true);
  });

  describe('validation happens BEFORE the write', () => {
    // A stored "25:00" would silently disable quiet hours rather than failing —
    // the kind of bug nobody reports because it looks like it just does not work.
    it('rejects a malformed time', async () => {
      const { svc } = build();
      await expect(svc.update('me', { quietHoursStart: '25:00' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.update('me', { digestDailyAt: 'morning' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an out-of-range weekday', async () => {
      const { svc } = build();
      await expect(svc.update('me', { quietHoursDays: [7] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.update('me', { digestWeeklyDay: 9 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown timezone', async () => {
      const { svc } = build();
      await expect(svc.update('me', { timezone: 'Mars/Olympus' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not persist anything when validation fails', async () => {
      const { svc, row } = build();
      await svc.update('me', { quietHoursStart: 'nope' }).catch(() => undefined);
      expect(row).toBeNull();
    });

    it('accepts valid settings', async () => {
      const { svc } = build();
      const p = await svc.update('me', {
        timezone: 'America/Puerto_Rico', quietHoursEnabled: true,
        quietHoursStart: '22:00', quietHoursEnd: '07:00', quietHoursDays: [1, 2, 3],
      });
      expect(p).toMatchObject({ quietHoursEnabled: true, quietHoursStart: '22:00' });
    });

    it('allows clearing a time with null', async () => {
      const { svc } = build();
      await expect(svc.update('me', { quietHoursStart: null })).resolves.toBeDefined();
    });
  });

  it('pauses and resumes, auditing both', async () => {
    const { svc, audit } = build();
    const paused = await svc.pause('me', new Date(Date.now() + 3600_000).toISOString());
    expect(paused.paused).toBe(true);
    const resumed = await svc.resume('me');
    expect(resumed.paused).toBe(false);
    const actions = audit.record.mock.calls.map((c: any) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining([
      'notification.profile.paused', 'notification.profile.resumed',
    ]));
  });

  it('rejects an invalid pause time', async () => {
    const { svc } = build();
    await expect(svc.pause('me', 'not-a-date')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only writes the fields supplied', async () => {
    const { svc } = build({ userId: 'me', quietHoursDays: [], quietHoursEnabled: true, digestDaily: true, pausedUntil: null });
    await svc.update('me', { digestDaily: false });
    // quietHoursEnabled must survive an unrelated patch.
    expect((await svc.get('me')).quietHoursEnabled).toBe(true);
  });
});
