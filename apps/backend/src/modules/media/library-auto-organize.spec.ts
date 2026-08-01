/**
 * "How do I place a file" and "may the organiser act on its own" are two
 * questions. `mode` used to answer both.
 *
 * Five of its six values were real filesystem verbs. The sixth, `preview`, meant
 * "do nothing" — an opt-out wearing a verb's clothes. Because a library stored
 * exactly one mode, choosing `preview` to keep the background organiser away
 * also:
 *
 *   - vetoed a manual, explicitly-confirmed rename. `apply` short-circuits on
 *     `preview`, so Execute reported "0 applied, 253 skipped" — and reported it
 *     as SUCCESS. The button had never been able to do anything.
 *   - changed destination resolution, re-rooting under the library path instead
 *     of reusing the file's own show folder, so the plan on screen was not the
 *     plan an execute would produce. `media-automation.actions.ts` already knew
 *     this and used `dryRun` with the real mode; the manual screens did not.
 *
 * `autoOrganize` now carries the first question alone, and a library's mode is
 * always a real verb.
 */
import { BadRequestException } from '@nestjs/common';
import { MediaService } from './media.service';

function build() {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const prisma = {
    mediaLibrary: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'lib1', ...data };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return { id: 'lib1', ...data };
      }),
    },
  };
  const svc = new MediaService(
    prisma as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never,
  );
  return { svc, created, updated };
}

const base = { name: 'TV Shows', path: '/downloads/TV Shows' };

/*
 * These throw SYNCHRONOUSLY, before the Prisma promise is created — the same way
 * the pre-existing name/path validation in `createLibrary` does. Asserting with
 * `.rejects` would fail even though the guard fired, so the expectations are
 * sync on purpose rather than by oversight.
 */
describe('a library mode is a filesystem verb', () => {
  it('refuses to store "preview" on a library', () => {
    const { svc } = build();
    expect(() => svc.createLibrary({ ...base, mode: 'preview' })).toThrow(BadRequestException);
  });

  it('says what to do instead, rather than just refusing', () => {
    // The operator picked `preview` for a real reason — to stop the organiser.
    // An error that does not name the replacement just moves the confusion.
    const { svc } = build();
    expect(() => svc.createLibrary({ ...base, mode: 'preview' })).toThrow(/automatic organising/i);
  });

  it('refuses an unknown mode too', () => {
    const { svc } = build();
    expect(() => svc.createLibrary({ ...base, mode: 'teleport' })).toThrow(/Unknown library mode/);
  });

  it('blocks "preview" on update, not just create', () => {
    const { svc } = build();
    expect(() => svc.updateLibrary('lib1', { mode: 'preview' })).toThrow(BadRequestException);
  });

  it('leaves an update that does not touch the mode alone', async () => {
    // `undefined` means "not being changed" and must not be mistaken for invalid.
    const { svc, updated } = build();
    await svc.updateLibrary('lib1', { name: 'Renamed' });
    expect(updated[0]).toMatchObject({ name: 'Renamed' });
  });

  it.each(['rename_in_place', 'rename_move', 'copy', 'hardlink', 'symlink'])(
    'accepts the real verb %s',
    async (mode) => {
      const { svc, created } = build();
      await svc.createLibrary({ ...base, mode });
      expect(created[0]).toMatchObject({ mode });
    },
  );
});

describe('autoOrganize', () => {
  it('defaults to off, so a new library is inert until opted in', async () => {
    const { svc, created } = build();
    await svc.createLibrary({ ...base, mode: 'rename_in_place' });
    expect(created[0].autoOrganize).toBe(false);
  });

  it('is stored independently of the mode', async () => {
    const { svc, created } = build();
    await svc.createLibrary({ ...base, mode: 'rename_in_place', autoOrganize: true });
    expect(created[0]).toMatchObject({ mode: 'rename_in_place', autoOrganize: true });
  });

  it('lets a library keep a real verb while opting out of the organiser', async () => {
    // Precisely what `preview` used to be used for — minus the two side effects.
    const { svc, created } = build();
    await svc.createLibrary({ ...base, mode: 'rename_in_place', autoOrganize: false });
    expect(created[0]).toMatchObject({ mode: 'rename_in_place', autoOrganize: false });
  });
});
