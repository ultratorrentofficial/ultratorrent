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
  ProviderSession,
  ServerInfo,
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
    // Back-compat: the settings form persists the server address as `url`, but
    // every provider reads `baseUrl`. Alias it so both stored shapes work.
    if (out.baseUrl == null && typeof out.url === 'string') out.baseUrl = out.url;
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
    status?: string | null;
    lastHealthCheckAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      isEnabled: row.isEnabled,
      lastRefreshAt: row.lastRefreshAt,
      // Surfaced so the UI can show a server as down. Without these the client had
      // no way to know: the row carried a status, but it was never returned.
      status: row.status ?? 'unknown',
      lastHealthCheckAt: row.lastHealthCheckAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      config: this.redactConfig((row.config as Record<string, unknown>) ?? {}),
    };
  }

  /**
   * Persist the outcome of any real conversation with the server.
   *
   * `status` is what the dashboard reads, so EVERY path that actually talks to the
   * server has to write it. Previously only {@link healthCheck} did, and nothing
   * called that on a schedule — so a Plex that had been dead for four days sat at
   * `status: 'online'` through 479 consecutive refresh failures, and the UI showed
   * it as healthy the whole time.
   *
   * Never allowed to throw: this runs on the failure path of the caller, and a
   * bookkeeping error must not replace the real error the caller is about to raise.
   */
  private async markHealth(id: string, online: boolean): Promise<void> {
    try {
      await this.prisma.mediaServerIntegration.update({
        where: { id },
        data: { status: online ? 'online' : 'offline', lastHealthCheckAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`Could not persist health for ${id}: ${(err as Error).message}`);
    }
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
    await this.markHealth(id, result.ok);
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
      // A refresh that couldn't reach the server IS a health signal — the most
      // frequent one there is, since this fires on every completed download.
      await this.markHealth(id, false);
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
    const now = new Date();
    const updated = await this.prisma.mediaServerIntegration.update({
      where: { id },
      data: { lastRefreshAt: now, status: 'online', lastHealthCheckAt: now },
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
  async healthCheck(id: string): Promise<ServerInfo> {
    const row = await this.load(id);
    const provider = getMediaServerProvider(row.kind);
    const cfg = this.decryptConfig((row.config as Record<string, unknown>) ?? {});

    let info: ServerInfo;
    try {
      info = await provider.getServerInfo(cfg);
    } catch (err) {
      // Providers report an unreachable server as `reachable: false`, but they can
      // still throw outright on a config-level fault (missing/garbage baseUrl, a
      // decrypt failure). That is still "we cannot reach this server" — record it,
      // rather than propagating and leaving the last-known status standing.
      info = {
        kind: row.kind as MediaServerKind,
        reachable: false,
        capabilities: provider.capabilities(),
        message: (err as Error).message,
      };
    }

    await this.prisma.mediaServerIntegration.update({
      where: { id },
      data: {
        status: info.reachable ? 'online' : 'offline',
        // Only overwrite version/platform on a reachable probe — a failed one knows
        // nothing about them, and nulling them would discard what we last learned.
        ...(info.reachable
          ? {
              serverVersion: info.version ?? null,
              platform: info.platform ?? null,
              capabilities: info.capabilities as unknown as Prisma.InputJsonValue,
            }
          : {}),
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

  /**
   * Now-playing sessions for a saved integration. Unsupported providers (Kodi)
   * return `{ supported: false }` rather than throwing.
   */
  async sessions(id: string): Promise<{ supported: boolean; message?: string; sessions: ProviderSession[] }> {
    const row = await this.load(id);
    const provider = getMediaServerProvider(row.kind);
    const cfg = this.decryptConfig((row.config as Record<string, unknown>) ?? {});
    try {
      return { supported: true, sessions: await provider.getSessions(cfg) };
    } catch (err) {
      if (err instanceof UnsupportedCapabilityError) {
        return { supported: false, message: err.message, sessions: [] };
      }
      throw new BadRequestException(`Fetching sessions failed: ${(err as Error).message}`);
    }
  }

  /**
   * Fetch a provider image (e.g. a now-playing poster) with the connection's
   * credentials injected server-side, so the token/API key never reaches the
   * browser. `relPath` is a provider-relative path captured from the provider
   * itself (not client input), so the target host stays bounded to the
   * configured server. Returns null on any failure — artwork is best-effort.
   */
  async fetchArtwork(
    connectionId: string,
    relPath: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    if (!relPath) return null;
    let row;
    try {
      row = await this.load(connectionId);
    } catch {
      return null;
    }
    const cfg = this.decryptConfig((row.config as Record<string, unknown>) ?? {});
    const base = (cfg.baseUrl ?? '').replace(/\/+$/, '');
    if (!base) return null;
    try {
      const url = new URL(/^https?:\/\//.test(relPath) ? relPath : base + (relPath.startsWith('/') ? relPath : `/${relPath}`));
      const headers: Record<string, string> = {};
      if (row.kind === 'plex' && cfg.token) url.searchParams.set('X-Plex-Token', cfg.token);
      if ((row.kind === 'jellyfin' || row.kind === 'emby') && cfg.apiKey) headers['X-Emby-Token'] = cfg.apiKey;
      const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') ?? 'image/jpeg';
      if (!contentType.startsWith('image/')) return null;
      return { body: Buffer.from(await res.arrayBuffer()), contentType };
    } catch {
      return null;
    }
  }
}
