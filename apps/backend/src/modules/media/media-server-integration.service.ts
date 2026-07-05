import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from './media-metadata.service';
import {
  getMediaServerProvider,
  MediaServerConfig,
  MediaServerKind,
  MediaServerLibrary,
  UnsupportedCapabilityError,
} from './media-server-provider';

/** Config keys treated as secrets and encrypted at rest. */
const SECRET_KEYS = ['token', 'apiKey', 'password'] as const;
const VALID_KINDS: MediaServerKind[] = ['plex', 'jellyfin', 'emby', 'kodi'];

export interface IntegrationInput {
  name?: string;
  kind?: string;
  isEnabled?: boolean;
  config?: Record<string, unknown>;
}

/**
 * CRUD + connection testing for media-server integrations. Secret config fields
 * are AES-GCM encrypted at rest (SecretCipher) and never returned or logged.
 */
@Injectable()
export class MediaServerIntegrationService {
  private readonly logger = new Logger(MediaServerIntegrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
    private readonly audit: AuditService,
  ) {}

  /** Encrypt secret fields; leave the rest as-is. */
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

  /** Decrypt secret fields for provider use (never returned to the client). */
  private decryptConfig(stored: Record<string, unknown>): MediaServerConfig {
    const encFields = new Set((stored.__encrypted as string[]) ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored ?? {})) {
      if (k === '__encrypted') continue;
      if (encFields.has(k) && typeof v === 'string') {
        try {
          out[k] = this.cipher.decrypt(v);
        } catch {
          out[k] = undefined; // corrupt/rotated key — fail closed on that field
        }
      } else {
        out[k] = v;
      }
    }
    return out as MediaServerConfig;
  }

  /** Strip secrets before returning config to the client. */
  private redactConfig(stored: Record<string, unknown>): Record<string, unknown> {
    const encFields = new Set((stored.__encrypted as string[]) ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored ?? {})) {
      if (k === '__encrypted') continue;
      if (encFields.has(k) || SECRET_KEYS.includes(k as (typeof SECRET_KEYS)[number])) {
        out[k] = v ? '••••••••' : '';
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private serialize(row: {
    id: string;
    name: string;
    kind: string;
    config: unknown;
    isEnabled: boolean;
    lastRefreshAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      isEnabled: row.isEnabled,
      lastRefreshAt: row.lastRefreshAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      config: this.redactConfig((row.config as Record<string, unknown>) ?? {}),
    };
  }

  async list() {
    const rows = await this.prisma.mediaServerIntegration.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  async create(input: IntegrationInput, ctx: AuditContext = {}) {
    if (!input?.name || !input?.kind) {
      throw new BadRequestException('name and kind are required.');
    }
    if (!VALID_KINDS.includes(input.kind as MediaServerKind)) {
      throw new BadRequestException(`Unsupported kind "${input.kind}".`);
    }
    const row = await this.prisma.mediaServerIntegration.create({
      data: {
        name: input.name,
        kind: input.kind,
        isEnabled: input.isEnabled ?? true,
        config: this.encryptConfig(input.config ?? {}) as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.integration.create',
      objectType: 'media_server_integration',
      objectId: row.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { kind: row.kind },
    });
    return this.serialize(row);
  }

  async update(id: string, input: IntegrationInput, ctx: AuditContext = {}) {
    const existing = await this.prisma.mediaServerIntegration.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Integration not found');
    if (input.kind && !VALID_KINDS.includes(input.kind as MediaServerKind)) {
      throw new BadRequestException(`Unsupported kind "${input.kind}".`);
    }

    const data: Prisma.MediaServerIntegrationUpdateInput = {
      name: input.name,
      kind: input.kind,
      isEnabled: input.isEnabled,
    };
    if (input.config !== undefined) {
      // Merge into existing config so unchanged secrets need not be resent.
      const current = (existing.config as Record<string, unknown>) ?? {};
      const decrypted = this.decryptConfig(current) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...decrypted };
      for (const [k, v] of Object.entries(input.config)) {
        // A redacted secret placeholder means "keep existing".
        if (
          SECRET_KEYS.includes(k as (typeof SECRET_KEYS)[number]) &&
          typeof v === 'string' &&
          /^•+$/.test(v)
        ) {
          continue;
        }
        merged[k] = v;
      }
      data.config = this.encryptConfig(merged) as Prisma.InputJsonValue;
    }

    const row = await this.prisma.mediaServerIntegration.update({ where: { id }, data });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.integration.update',
      objectType: 'media_server_integration',
      objectId: id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return this.serialize(row);
  }

  async remove(id: string, ctx: AuditContext = {}) {
    const existing = await this.prisma.mediaServerIntegration.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Integration not found');
    await this.prisma.mediaServerIntegration.delete({ where: { id } });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.integration.delete',
      objectType: 'media_server_integration',
      objectId: id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return { id, deleted: true };
  }

  private async load(id: string) {
    const row = await this.prisma.mediaServerIntegration.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Integration not found');
    return row;
  }

  /** Probe a saved integration's connection. */
  async test(id: string, ctx: AuditContext = {}) {
    const row = await this.load(id);
    const provider = getMediaServerProvider(row.kind);
    const cfg = this.decryptConfig((row.config as Record<string, unknown>) ?? {});
    const result = await provider.testConnection(cfg);
    if (!result.ok) {
      // Audit the failure WITHOUT the secret config.
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.integration.test_failed',
        objectType: 'media_server_integration',
        objectId: id,
        result: 'failure',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { kind: row.kind, message: result.message },
      });
    }
    return result;
  }

  /** Trigger a library refresh on a saved integration. */
  async refresh(id: string, ctx: AuditContext = {}) {
    const row = await this.load(id);
    if (!row.isEnabled) {
      throw new BadRequestException('Integration is disabled.');
    }
    const provider = getMediaServerProvider(row.kind);
    const cfg = this.decryptConfig((row.config as Record<string, unknown>) ?? {});
    try {
      await provider.refreshLibrary(cfg);
    } catch (err) {
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.integration.refresh_failed',
        objectType: 'media_server_integration',
        objectId: id,
        result: 'failure',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { kind: row.kind, message: (err as Error).message },
      });
      throw new BadRequestException(`Refresh failed: ${(err as Error).message}`);
    }
    const updated = await this.prisma.mediaServerIntegration.update({
      where: { id },
      data: { lastRefreshAt: new Date() },
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.integration.refresh',
      objectType: 'media_server_integration',
      objectId: id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { kind: row.kind },
    });
    return { id, lastRefreshAt: updated.lastRefreshAt };
  }

  /**
   * Probe a server and persist its analytics health (status/version/platform/
   * capabilities). Used by Media Server Analytics.
   */
  async healthCheck(id: string) {
    const row = await this.load(id);
    const provider = getMediaServerProvider(row.kind);
    const cfg = this.decryptConfig((row.config as Record<string, unknown>) ?? {});
    const info = await provider.getServerInfo(cfg);
    await this.prisma.mediaServerIntegration.update({
      where: { id },
      data: {
        status: info.reachable ? 'online' : 'offline',
        serverVersion: info.version ?? null,
        platform: info.platform ?? null,
        capabilities: info.capabilities as unknown as Prisma.InputJsonValue,
        lastHealthCheckAt: new Date(),
      },
    });
    return info;
  }

  /**
   * List a server's libraries. Providers that can't (e.g. Kodi) return a clean
   * `{ supported: false }` rather than throwing.
   */
  async libraries(id: string): Promise<{ supported: boolean; message?: string; libraries: MediaServerLibrary[] }> {
    const row = await this.load(id);
    const provider = getMediaServerProvider(row.kind);
    const cfg = this.decryptConfig((row.config as Record<string, unknown>) ?? {});
    try {
      return { supported: true, libraries: await provider.getLibraries(cfg) };
    } catch (err) {
      if (err instanceof UnsupportedCapabilityError) {
        return { supported: false, message: err.message, libraries: [] };
      }
      throw new BadRequestException(`Listing libraries failed: ${(err as Error).message}`);
    }
  }
}
