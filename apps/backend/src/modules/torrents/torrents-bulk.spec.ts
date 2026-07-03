import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as path from 'node:path';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { TorrentsService } from './torrents.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

// Emulate FilePathService.assertWithinHardRoots: allow /downloads/*, else throw.
const filePath = {
  assertWithinHardRoots: jest.fn((p: string) => {
    const abs = path.resolve(p);
    if (abs !== '/downloads' && !abs.startsWith('/downloads/')) {
      throw new ForbiddenException('outside roots');
    }
    return abs;
  }),
} as any;

describe('TorrentsService.bulk — per-action authorization', () => {
  const provider = {
    startTorrent: jest.fn().mockResolvedValue(undefined),
    removeTorrent: jest.fn().mockResolvedValue(undefined),
    removeTorrentAndData: jest.fn().mockResolvedValue(undefined),
    addMagnet: jest.fn().mockResolvedValue('hash'),
  };
  const registry = { resolve: jest.fn().mockResolvedValue(provider) } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const prisma = {} as any;
  const svc = new TorrentsService(registry, audit, filePath, prisma);

  const user = (perms: string[], roles: string[] = []): AuthenticatedUser => ({
    id: 'u1',
    username: 'u',
    roles,
    permissions: perms,
  });

  beforeEach(() => jest.clearAllMocks());

  it('rejects removeData for a viewer without delete_data permission', async () => {
    await expect(
      svc.bulk(['h1'], 'removeData', undefined, user([PERMISSIONS.TORRENTS_VIEW]), {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(provider.removeTorrentAndData).not.toHaveBeenCalled();
    // The denial is audited as a failure.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'torrents.bulk.removeData', result: 'failure' }),
    );
  });

  it('allows removeData when the caller holds delete_data', async () => {
    const res = await svc.bulk(
      ['h1', 'h2'],
      'removeData',
      undefined,
      user([PERMISSIONS.TORRENTS_DELETE_DATA]),
      {},
    );
    expect(provider.removeTorrentAndData).toHaveBeenCalledTimes(2);
    expect(res.succeeded).toBe(2);
  });

  it('lets SUPER_ADMIN bypass the per-action check', async () => {
    await svc.bulk(['h1'], 'removeData', undefined, user([], [SystemRole.SUPER_ADMIN]), {});
    expect(provider.removeTorrentAndData).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown action', async () => {
    await expect(
      svc.bulk(['h1'], 'nuke', undefined, user([], [SystemRole.SUPER_ADMIN]), {}),
    ).rejects.toBeTruthy();
  });
});

describe('TorrentsService.add/move — save-path safety', () => {
  const provider = { addMagnet: jest.fn().mockResolvedValue('h'), moveStorage: jest.fn().mockResolvedValue(undefined) };
  const registry = { resolve: jest.fn().mockResolvedValue(provider) } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const prisma = {} as any;
  const svc = new TorrentsService(registry, audit, filePath, prisma);
  const actor = { id: 'u', username: 'u', roles: [], permissions: [] } as AuthenticatedUser;

  beforeEach(() => jest.clearAllMocks());

  it('accepts a save path inside the allowed roots', async () => {
    await svc.add({ magnet: 'magnet:?xt=urn:btih:x', savePath: '/downloads/movies' } as any, undefined, actor, {});
    expect(provider.addMagnet).toHaveBeenCalled();
  });

  it('rejects a save path outside the allowed roots', async () => {
    await expect(
      svc.add({ magnet: 'magnet:?xt=urn:btih:x', savePath: '/etc' } as any, undefined, actor, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(provider.addMagnet).not.toHaveBeenCalled();
  });

  it('rejects a save path containing a command-breakout quote', async () => {
    await expect(
      svc.add({ magnet: 'magnet:?x', savePath: '/downloads/a" d.execute=x' } as any, undefined, actor, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a category containing illegal characters', async () => {
    await expect(
      svc.add({ magnet: 'magnet:?x', category: 'tv" x' } as any, undefined, actor, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates the move destination against the roots', async () => {
    // Validation is synchronous (move is not async), so it throws directly.
    expect(() => svc.move('h', '/etc', undefined, actor, {})).toThrow(ForbiddenException);
    await svc.move('h', '/downloads/done', undefined, actor, {});
    expect(provider.moveStorage).toHaveBeenCalledWith('h', '/downloads/done');
  });
});
