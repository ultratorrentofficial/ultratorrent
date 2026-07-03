import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  AddTorrentOptions,
  FilePriority,
  NormalizedTorrent,
  PERMISSIONS,
  SystemRole,
  TorrentMatchedRule,
  TorrentPriority,
  TorrentState,
} from '@ultratorrent/shared';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { AuditService } from '../audit/audit.service';
import { FilePathService } from '../files/file-path.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { infoHashFromTorrent } from '../../infrastructure/rtorrent/bencode';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/** Reject quote/control chars that could break out of rTorrent command strings. */
const UNSAFE_PATH_CHARS = /["\r\n\t\0]/;

/**
 * Per-action permission for `/torrents/bulk`. The blanket-`torrents.view` route
 * must NOT let a viewer run destructive actions — each action requires the same
 * permission as its dedicated single-torrent route.
 */
const BULK_ACTION_PERMISSIONS: Record<string, string> = {
  start: PERMISSIONS.TORRENTS_START,
  stop: PERMISSIONS.TORRENTS_STOP,
  pause: PERMISSIONS.TORRENTS_PAUSE,
  resume: PERMISSIONS.TORRENTS_RESUME,
  recheck: PERMISSIONS.TORRENTS_RECHECK,
  remove: PERMISSIONS.TORRENTS_DELETE,
  removeData: PERMISSIONS.TORRENTS_DELETE_DATA,
};

export interface ListTorrentsQuery {
  engineId?: string;
  state?: TorrentState;
  category?: string;
  search?: string;
  sortBy?: keyof NormalizedTorrent;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

@Injectable()
export class TorrentsService {
  constructor(
    private readonly registry: EngineRegistryService,
    private readonly audit: AuditService,
    private readonly filePath: FilePathService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Constrain a caller-supplied storage path to FILE_MANAGER_ROOTS and reject
   * characters that could break out of the engine command string. Returns the
   * normalized absolute path.
   */
  private safeStoragePath(input: string, label: string): string {
    if (UNSAFE_PATH_CHARS.test(input)) {
      throw new BadRequestException(`Invalid ${label}: illegal characters`);
    }
    return this.filePath.assertWithinHardRoots(input);
  }

  async list(query: ListTorrentsQuery) {
    const provider = await this.registry.resolve(query.engineId);
    let torrents = await provider.listTorrents();

    if (query.state) torrents = torrents.filter((t) => t.state === query.state);
    if (query.category)
      torrents = torrents.filter((t) => t.label === query.category);
    if (query.search) {
      const q = query.search.toLowerCase();
      torrents = torrents.filter(
        (t) => t.name.toLowerCase().includes(q) || t.hash.includes(q),
      );
    }

    const sortBy = query.sortBy ?? 'addedAt';
    const dir = query.sortDir === 'asc' ? 1 : -1;
    torrents.sort((a, b) => {
      const av = a[sortBy] as unknown as number | string;
      const bv = b[sortBy] as unknown as number | string;
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * dir;
    });

    const total = torrents.length;
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 50, 500);
    const items = torrents.slice((page - 1) * pageSize, page * pageSize);
    return { items, total, page, pageSize };
  }

  async get(hash: string, engineId?: string) {
    const provider = await this.registry.resolve(engineId);
    return provider.getTorrent(hash);
  }

  /**
   * The RSS automation rule that auto-downloaded this torrent, resolved by
   * info-hash from the recorded match evaluation. Returns null for manually
   * added torrents (no evaluation row). Hash comparison is case-insensitive
   * since the engine-reported hash and the stored hash may differ in case.
   */
  async getMatchedRule(hash: string): Promise<TorrentMatchedRule | null> {
    const evaluation = await this.prisma.rssRuleMatchEvaluation.findFirst({
      where: {
        torrentHash: { equals: hash, mode: 'insensitive' },
        actionTaken: 'download',
      },
      orderBy: { createdAt: 'desc' },
      include: { rule: true },
    });
    if (!evaluation) return null;
    return {
      ruleId: evaluation.rssRuleId,
      ruleName: evaluation.rule.name,
      feedId: evaluation.rule.feedId,
      matchedCandidateId: evaluation.matchedCandidateId,
      matchedAt: evaluation.createdAt.toISOString(),
    };
  }

  async getFiles(hash: string, engineId?: string) {
    return (await this.registry.resolve(engineId)).getFiles(hash);
  }

  async getPeers(hash: string, engineId?: string) {
    return (await this.registry.resolve(engineId)).getPeers(hash);
  }

  async getTrackers(hash: string, engineId?: string) {
    return (await this.registry.resolve(engineId)).getTrackers(hash);
  }

  async add(
    opts: { magnet?: string; url?: string; file?: Buffer } & AddTorrentOptions,
    engineId: string | undefined,
    user: AuthenticatedUser,
    ctx: { ipAddress?: string; userAgent?: string },
  ): Promise<{ hash: string }> {
    // Constrain the save path to the allowed roots and strip command-breakout
    // chars before the value reaches the engine.
    if (opts.savePath) opts.savePath = this.safeStoragePath(opts.savePath, 'save path');
    if (opts.category && UNSAFE_PATH_CHARS.test(opts.category)) {
      throw new BadRequestException('Invalid category: illegal characters');
    }

    // Reject a malformed/hostile .torrent up front (400) before it reaches the
    // engine, rather than surfacing a parser throw as a 500.
    if (opts.file) {
      try {
        infoHashFromTorrent(opts.file);
      } catch {
        throw new BadRequestException('Invalid .torrent file');
      }
    }

    const provider = await this.registry.resolve(engineId);
    let hash: string;
    if (opts.file) {
      hash = await provider.addTorrentFile(opts.file, opts);
    } else if (opts.magnet) {
      hash = await provider.addMagnet(opts.magnet, opts);
    } else if (opts.url) {
      hash = await provider.addTorrentURL(opts.url, opts);
    } else {
      throw new Error('No torrent source provided');
    }
    await this.audit.record({
      userId: user.id,
      action: 'torrents.add',
      objectType: 'torrent',
      objectId: hash,
      result: 'success',
      ...ctx,
    });
    return { hash };
  }

  private async act(
    hash: string,
    engineId: string | undefined,
    action: string,
    fn: (p: import('../../domain/engine/torrent-engine-provider.interface').TorrentEngineProvider) => Promise<void>,
    user: AuthenticatedUser,
    ctx: { ipAddress?: string; userAgent?: string },
  ) {
    const provider = await this.registry.resolve(engineId);
    await fn(provider);
    await this.audit.record({
      userId: user.id,
      action,
      objectType: 'torrent',
      objectId: hash,
      result: 'success',
      ...ctx,
    });
    return { success: true };
  }

  start(hash: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.start', (p) => p.startTorrent(hash), user, ctx);
  }
  stop(hash: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.stop', (p) => p.stopTorrent(hash), user, ctx);
  }
  pause(hash: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.pause', (p) => p.pauseTorrent(hash), user, ctx);
  }
  resume(hash: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.resume', (p) => p.resumeTorrent(hash), user, ctx);
  }
  recheck(hash: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.recheck', (p) => p.recheckTorrent(hash), user, ctx);
  }
  remove(hash: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.delete', (p) => p.removeTorrent(hash), user, ctx);
  }
  removeData(hash: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.delete_data', (p) => p.removeTorrentAndData(hash), user, ctx);
  }
  move(hash: string, dest: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    const safeDest = this.safeStoragePath(dest, 'destination');
    return this.act(hash, engineId, 'torrents.move', (p) => p.moveStorage(hash, safeDest), user, ctx);
  }
  setUploadLimit(hash: string, n: number, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.manage_limits', (p) => p.setUploadLimit(hash, n), user, ctx);
  }
  setDownloadLimit(hash: string, n: number, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.manage_limits', (p) => p.setDownloadLimit(hash, n), user, ctx);
  }
  setPriority(hash: string, prio: TorrentPriority, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.manage_limits', (p) => p.setTorrentPriority(hash, prio), user, ctx);
  }
  setFilePriority(hash: string, fileIndex: number, prio: FilePriority, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.manage_files', (p) => p.setFilePriority(hash, fileIndex, prio), user, ctx);
  }
  addTracker(hash: string, url: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.manage_trackers', (p) => p.addTracker(hash, url), user, ctx);
  }
  removeTracker(hash: string, url: string, engineId: string | undefined, user: AuthenticatedUser, ctx: any) {
    return this.act(hash, engineId, 'torrents.manage_trackers', (p) => p.removeTracker(hash, url), user, ctx);
  }

  async bulk(
    hashes: string[],
    action: string,
    engineId: string | undefined,
    user: AuthenticatedUser,
    ctx: any,
  ) {
    const required = BULK_ACTION_PERMISSIONS[action];
    if (!required) throw new BadRequestException(`Unknown bulk action: ${action}`);

    // Enforce the action's permission (the route only requires torrents.view).
    // SUPER_ADMIN bypasses, mirroring PermissionsGuard.
    const isSuperAdmin = user.roles?.includes(SystemRole.SUPER_ADMIN);
    if (!isSuperAdmin && !user.permissions?.includes(required)) {
      await this.audit.record({
        userId: user.id,
        action: `torrents.bulk.${action}`,
        result: 'failure',
        metadata: { count: hashes.length, reason: 'forbidden', required },
        ...ctx,
      });
      throw new ForbiddenException(`Missing permission: ${required}`);
    }

    const provider = await this.registry.resolve(engineId);
    const map: Record<string, (h: string) => Promise<void>> = {
      start: (h) => provider.startTorrent(h),
      stop: (h) => provider.stopTorrent(h),
      pause: (h) => provider.pauseTorrent(h),
      resume: (h) => provider.resumeTorrent(h),
      recheck: (h) => provider.recheckTorrent(h),
      remove: (h) => provider.removeTorrent(h),
      removeData: (h) => provider.removeTorrentAndData(h),
    };
    const fn = map[action];
    if (!fn) throw new BadRequestException(`Unknown bulk action: ${action}`);
    const results = await Promise.allSettled(hashes.map(fn));
    await this.audit.record({
      userId: user.id,
      action: `torrents.bulk.${action}`,
      result: 'success',
      metadata: { count: hashes.length },
      ...ctx,
    });
    return {
      succeeded: results.filter((r) => r.status === 'fulfilled').length,
      failed: results.filter((r) => r.status === 'rejected').length,
    };
  }
}
