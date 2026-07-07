import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Indexer, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { AuditService } from '../audit/audit.service';
import { releaseIdentity } from '../rss/torrent-name-parser';
import {
  IndexerCandidate,
  IndexerConnection,
  TorznabClient,
  TvSearchQuery,
} from './torznab-client';
import { CreateIndexerDto, UpdateIndexerDto } from './dto/indexer.dto';

/** Config keys treated as secrets and encrypted at rest. */
const SECRET_KEYS = ['apiKey'] as const;
const MASK = '••••••••';

export interface AuditCtx {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * CRUD + capability testing + search across Torznab/Newznab indexers. The API
 * key is AES-256-GCM encrypted inside `Indexer.config` (SecretCipher) and never
 * returned or logged. `searchAll` fans out across enabled indexers (priority
 * order), isolates per-indexer failures, and dedups candidates cross-indexer.
 */
@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
    private readonly audit: AuditService,
    private readonly client: TorznabClient,
  ) {}

  // --- secret handling (mirrors MediaServerIntegrationService) --------------

  private encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const encFields: string[] = [];
    for (const [k, v] of Object.entries(config ?? {})) {
      if (SECRET_KEYS.includes(k as (typeof SECRET_KEYS)[number]) && typeof v === 'string' && v) {
        out[k] = this.cipher.encrypt(v);
        encFields.push(k);
      } else {
        out[k] = v;
      }
    }
    if (encFields.length) out.__encrypted = encFields;
    return out;
  }

  private decryptConfig(stored: Record<string, unknown>): Record<string, unknown> {
    const encFields = new Set((stored.__encrypted as string[]) ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored ?? {})) {
      if (k === '__encrypted') continue;
      if (encFields.has(k) && typeof v === 'string') {
        try {
          out[k] = this.cipher.decrypt(v);
        } catch {
          out[k] = undefined; // rotated/corrupt key — fail closed on that field
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private hasSecret(stored: Record<string, unknown>, key: string): boolean {
    const encFields = new Set((stored?.__encrypted as string[]) ?? []);
    return encFields.has(key) && typeof stored?.[key] === 'string' && !!stored[key];
  }

  /** Public API shape — secrets masked, never ciphertext. */
  private serialize(row: Indexer) {
    const cfg = (row.config as Record<string, unknown>) ?? {};
    return {
      id: row.id,
      name: row.name,
      implementation: row.implementation,
      protocol: row.protocol,
      baseUrl: row.baseUrl,
      enabled: row.enabled,
      priority: row.priority,
      categories: row.categories,
      capabilities: row.capabilities,
      minSeeders: row.minSeeders,
      timeoutMs: row.timeoutMs,
      status: row.status,
      statusMessage: row.statusMessage,
      lastTestedAt: row.lastTestedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      apiKey: this.hasSecret(cfg, 'apiKey') ? MASK : '',
    };
  }

  // --- CRUD -----------------------------------------------------------------

  async list() {
    const rows = await this.prisma.indexer.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
    return rows.map((r) => this.serialize(r));
  }

  private async load(id: string): Promise<Indexer> {
    const row = await this.prisma.indexer.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Indexer not found');
    return row;
  }

  async get(id: string) {
    return this.serialize(await this.load(id));
  }

  async create(dto: CreateIndexerDto, ctx: AuditCtx = {}) {
    const config = this.encryptConfig({ apiKey: dto.apiKey ?? '' });
    const row = await this.prisma.indexer.create({
      data: {
        name: dto.name,
        implementation: dto.implementation ?? 'torznab',
        protocol: dto.protocol ?? 'torrent',
        baseUrl: dto.baseUrl,
        config: config as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
        priority: dto.priority ?? 25,
        categories: dto.categories ?? [5000, 5030, 5040],
        minSeeders: dto.minSeeders ?? null,
        timeoutMs: dto.timeoutMs ?? 15000,
      },
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'indexer.create',
      objectType: 'indexer',
      objectId: row.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { implementation: row.implementation },
    });
    return this.serialize(row);
  }

  async update(id: string, dto: UpdateIndexerDto, ctx: AuditCtx = {}) {
    const existing = await this.load(id);
    const data: Prisma.IndexerUpdateInput = {
      name: dto.name,
      implementation: dto.implementation,
      protocol: dto.protocol,
      baseUrl: dto.baseUrl,
      enabled: dto.enabled,
      priority: dto.priority,
      categories: dto.categories,
      minSeeders: dto.minSeeders,
      timeoutMs: dto.timeoutMs,
    };
    // A blank or masked apiKey means "keep existing"; a real value re-encrypts.
    if (dto.apiKey !== undefined && dto.apiKey !== '' && !/^•+$/.test(dto.apiKey)) {
      data.config = this.encryptConfig({ apiKey: dto.apiKey }) as Prisma.InputJsonValue;
    }
    const row = await this.prisma.indexer.update({ where: { id }, data });
    await this.audit.record({
      userId: ctx.userId,
      action: 'indexer.update',
      objectType: 'indexer',
      objectId: id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return this.serialize(row);
  }

  async remove(id: string, ctx: AuditCtx = {}) {
    await this.load(id);
    await this.prisma.indexer.delete({ where: { id } });
    await this.audit.record({
      userId: ctx.userId,
      action: 'indexer.delete',
      objectType: 'indexer',
      objectId: id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return { id, deleted: true };
  }

  // --- connection + search --------------------------------------------------

  private connection(row: Indexer): IndexerConnection {
    const cfg = this.decryptConfig((row.config as Record<string, unknown>) ?? {});
    return {
      id: row.id,
      name: row.name,
      implementation: row.implementation,
      baseUrl: row.baseUrl,
      apiKey: (cfg.apiKey as string) ?? '',
      categories: row.categories,
      timeoutMs: row.timeoutMs,
    };
  }

  /** Probe an indexer's capabilities and persist status. */
  async testConnection(id: string, ctx: AuditCtx = {}) {
    const row = await this.load(id);
    try {
      const caps = await this.client.fetchCaps(this.connection(row));
      const updated = await this.prisma.indexer.update({
        where: { id },
        data: {
          capabilities: caps as unknown as Prisma.InputJsonValue,
          status: 'ok',
          statusMessage: null,
          lastTestedAt: new Date(),
        },
      });
      await this.audit.record({ userId: ctx.userId, action: 'indexer.test', objectType: 'indexer', objectId: id, result: 'success' });
      return { indexer: this.serialize(updated), capabilities: caps };
    } catch (err) {
      const message = (err as Error).message;
      const updated = await this.prisma.indexer.update({
        where: { id },
        data: { status: 'error', statusMessage: message, lastTestedAt: new Date() },
      });
      await this.audit.record({ userId: ctx.userId, action: 'indexer.test', objectType: 'indexer', objectId: id, result: 'failure', metadata: { message } });
      return { indexer: this.serialize(updated), capabilities: null, error: message };
    }
  }

  /**
   * Search every enabled indexer (priority order) for a query, isolating
   * per-indexer failures, filtering by each indexer's `minSeeders`, and
   * deduping candidates cross-indexer (infoHash, else release identity). The
   * result is priority-ordered then by seeders desc.
   */
  async searchAll(query: TvSearchQuery): Promise<IndexerCandidate[]> {
    const rows = await this.prisma.indexer.findMany({
      where: { enabled: true },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    });
    const seen = new Set<string>();
    const out: IndexerCandidate[] = [];
    for (const row of rows) {
      try {
        const conn = this.connection(row);
        const caps = row.capabilities as { tvSearch?: boolean } | null;
        const useTvSearch = caps?.tvSearch !== false; // default to tvsearch unless caps say unsupported
        const candidates = await this.client.search(conn, query, useTvSearch);
        for (const c of candidates) {
          if (!c.title) continue;
          if (row.minSeeders != null && c.seeders != null && c.seeders < row.minSeeders) continue;
          const key = c.infoHash ?? releaseIdentity(c.title) ?? c.title.toLowerCase().trim();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(c);
        }
      } catch (err) {
        this.logger.warn(`Indexer search failed (${row.name}): ${(err as Error).message}`);
      }
    }
    return out.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
  }

  /** Ad-hoc search used by the controller's test-search endpoint. */
  async searchOne(id: string, query: TvSearchQuery): Promise<IndexerCandidate[]> {
    const row = await this.load(id);
    if (!row.enabled) throw new BadRequestException('Indexer is disabled');
    const caps = row.capabilities as { tvSearch?: boolean } | null;
    return this.client.search(this.connection(row), query, caps?.tvSearch !== false);
  }
}
