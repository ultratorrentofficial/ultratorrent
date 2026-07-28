/**
 * The display timezone is tri-state, and the three states must stay distinct:
 *
 * - **absent** from the request body — leave the stored zone alone
 * - **null / '' / 'auto'** — follow the device
 * - **a zone name** — use it
 *
 * The first two are easy to conflate, and conflating them is destructive: every
 * unrelated profile edit would silently reset someone's zone. That is exactly
 * what shipped — `'timezone' in dto` is true even for a body that never
 * mentioned it, because class-transformer defines optional properties on the
 * instance. Found by calling the endpoint, not by a test. Hence this file.
 */
import { BadRequestException } from '@nestjs/common';
import { AccountService } from './account.module';

function build(stored: string | null = null) {
  const row = { id: 'u1', timezone: stored } as Record<string, unknown>;
  const prisma = {
    user: {
      update: jest.fn(async ({ data }: any) => {
        // Prisma treats `undefined` as "no change" and `null` as "set null".
        if (data.timezone !== undefined) row.timezone = data.timezone;
        return row;
      }),
      findUniqueOrThrow: jest.fn(async () => ({
        ...row,
        username: 'u',
        email: 'u@example.com',
        displayName: null,
        totpEnabled: false,
        lastLoginAt: null,
        createdAt: new Date(),
        roles: [],
      })),
    },
  };
  return { svc: new AccountService(prisma as never), prisma, row };
}

describe('updating the profile timezone', () => {
  it('stores a valid zone', async () => {
    const { svc, row } = build(null);
    const out = await svc.updateProfile('u1', { timezone: 'America/Puerto_Rico' } as never);
    expect(row.timezone).toBe('America/Puerto_Rico');
    expect(out.timezone).toBe('America/Puerto_Rico');
  });

  it('LEAVES the zone alone when the body does not mention it', async () => {
    /*
     * The regression. Editing only a display name must not touch the zone —
     * and `undefined` must reach Prisma as "no change", never as null.
     */
    const { svc, prisma, row } = build('Europe/Madrid');
    await svc.updateProfile('u1', { displayName: 'New Name' } as never);

    expect(row.timezone).toBe('Europe/Madrid');
    expect(prisma.user.update.mock.calls[0][0].data.timezone).toBeUndefined();
  });

  it('clears the zone only when asked explicitly', async () => {
    const { svc, row } = build('Europe/Madrid');
    await svc.updateProfile('u1', { timezone: null } as never);
    expect(row.timezone).toBeNull();
  });

  it("treats '' and 'auto' as follow-the-device", async () => {
    for (const auto of ['', '  ', 'auto']) {
      const { svc, row } = build('Europe/Madrid');
      await svc.updateProfile('u1', { timezone: auto } as never);
      expect(row.timezone).toBeNull();
    }
  });

  it('refuses an unknown zone rather than storing null', async () => {
    // Silently discarding it would leave the user believing they set one.
    const { svc, row } = build('Europe/Madrid');
    await expect(svc.updateProfile('u1', { timezone: 'Mars/Olympus_Mons' } as never))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(row.timezone).toBe('Europe/Madrid');
  });

  it('refuses a bare UTC offset', async () => {
    // An offset is not an identity: `-04:00` is Puerto Rico all year and New
    // York only in summer, so storing one renders half the year wrong.
    const { svc } = build(null);
    await expect(svc.updateProfile('u1', { timezone: '-04:00' } as never))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
