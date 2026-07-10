import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../../common/crypto/secret-cipher';
import { AuditService } from '../../audit/audit.service';
import { TestProwlarrDto, UpdateProwlarrSettingsDto } from './dto/prowlarr.dto';
import { assertNotMetadata, parseProwlarrUrl } from './prowlarr-url';

/** Single settings row (generic KV store) — no dedicated table/migration. */
const SETTINGS_KEY = 'prowlarr.settings';
/** Config keys treated as secrets and encrypted at rest. */
const SECRET_KEYS = ['apiKey'] as const;
const MASK = '••••••••';

const DEFAULT_INTERNAL_URL = process.env.PROWLARR_BASE_URL || 'http://prowlarr:9696';
const DEFAULT_PUBLIC_URL = process.env.PROWLARR_PUBLIC_URL || 'http://localhost:9696';
const TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface AuditCtx {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

type Stored = Record<string, unknown>;

/**
 * Lightweight link-only integration with a **separate** Prowlarr companion
 * container. UltraTorrent does not embed Prowlarr or proxy arbitrary endpoints —
 * it stores connection settings (API key AES-256-GCM encrypted, never returned
 * or logged) and performs read-only health checks (`system/status`, indexer
 * count) so the operator can confirm the link and jump to the Prowlarr UI.
 *
 * Settings live in a single `prowlarr.settings` row of the generic KV `Setting`
 * store; the secret machinery mirrors `IndexerService`/`MediaServerIntegration`.
 */
@Injectable()
export class ProwlarrIntegrationService {
  private readonly logger = new Logger(ProwlarrIntegrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
    private readonly audit: AuditService,
  ) {}

  // --- secret handling (mirrors IndexerService) -----------------------------

  private encryptConfig(config: Stored): Stored {
    const out: Stored = {};
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

  private decryptConfig(stored: Stored): Stored {
    const encFields = new Set((stored.__encrypted as string[]) ?? []);
    const out: Stored = {};
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

  private hasSecret(stored: Stored, key: string): boolean {
    const encFields = new Set((stored?.__encrypted as string[]) ?? []);
    return encFields.has(key) && typeof stored?.[key] === 'string' && !!stored[key];
  }

  private async loadRaw(): Promise<Stored> {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    return ((row?.value as Stored) ?? {}) as Stored;
  }

  private async persist(value: Stored): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value: value as Prisma.InputJsonValue },
      update: { value: value as Prisma.InputJsonValue },
    });
  }

  /** Public API shape — secrets masked, never ciphertext. */
  private serialize(stored: Stored) {
    return {
      enabled: !!stored.enabled,
      internalUrl: (stored.internalUrl as string) || DEFAULT_INTERNAL_URL,
      publicUrl: (stored.publicUrl as string) || DEFAULT_PUBLIC_URL,
      hasApiKey: this.hasSecret(stored, 'apiKey'),
      apiKey: this.hasSecret(stored, 'apiKey') ? MASK : '',
      status: (stored.status as string) ?? 'unknown',
      statusMessage: (stored.statusMessage as string) ?? null,
      version: (stored.version as string) ?? null,
      indexerCount: (stored.indexerCount as number) ?? null,
      lastCheckedAt: (stored.lastCheckedAt as string) ?? null,
    };
  }

  // --- settings CRUD --------------------------------------------------------

  async get(_ctx: AuditCtx = {}) {
    // Reads are NOT audited: the settings page polls this endpoint, so a
    // `prowlarr.settings.viewed` per GET floods the audit trail (and the
    // dashboard's Recent activity) with meaningless noise. Only mutations
    // (`update`/`testConnection`) are audited.
    const stored = await this.loadRaw();
    return this.serialize(stored);
  }

  async update(dto: UpdateProwlarrSettingsDto, ctx: AuditCtx = {}) {
    const stored = await this.loadRaw();
    // Decrypt so we can re-encrypt cleanly; non-secret fields pass through.
    const merged = this.decryptConfig(stored);
    let apiKeyChanged = false;

    if (dto.enabled !== undefined) merged.enabled = dto.enabled;
    if (dto.internalUrl !== undefined) {
      merged.internalUrl = dto.internalUrl.trim()
        ? this.normalizeUrl(dto.internalUrl)
        : '';
    }
    if (dto.publicUrl !== undefined) {
      merged.publicUrl = dto.publicUrl.trim() ? this.normalizeUrl(dto.publicUrl) : '';
    }
    // A blank or masked apiKey means "keep existing"; a real value replaces it.
    if (dto.apiKey !== undefined && dto.apiKey !== '' && !/^•+$/.test(dto.apiKey)) {
      merged.apiKey = dto.apiKey.trim();
      apiKeyChanged = true;
    }

    await this.persist(this.encryptConfig(merged));

    await this.audit.record({
      userId: ctx.userId,
      action: 'prowlarr.settings.updated',
      objectType: 'setting',
      objectId: SETTINGS_KEY,
      metadata: { enabled: !!merged.enabled },
    });
    if (apiKeyChanged) {
      await this.audit.record({
        userId: ctx.userId,
        action: 'prowlarr.apikey.changed',
        objectType: 'setting',
        objectId: SETTINGS_KEY,
      });
    }
    return this.serialize(await this.loadRaw());
  }

  private normalizeUrl(raw: string): string {
    // Validates scheme + no-credentials; drops any trailing slash for clean joins.
    return parseProwlarrUrl(raw).toString().replace(/\/$/, '');
  }

  // --- connection health ----------------------------------------------------

  /**
   * Test connectivity using ad-hoc form values when provided, else the stored
   * settings. Persists the resulting status and audits the attempt.
   */
  async testConnection(dto: TestProwlarrDto = {}, ctx: AuditCtx = {}) {
    const stored = await this.loadRaw();
    const decrypted = this.decryptConfig(stored);
    const internalUrl =
      (dto.internalUrl && dto.internalUrl.trim()) || (decrypted.internalUrl as string) || DEFAULT_INTERNAL_URL;
    const apiKey =
      dto.apiKey && dto.apiKey !== '' && !/^•+$/.test(dto.apiKey)
        ? dto.apiKey.trim()
        : (decrypted.apiKey as string) || '';
    if (!apiKey) {
      throw new BadRequestException('A Prowlarr API key is required to test the connection');
    }

    try {
      const { version, indexerCount } = await this.probe(internalUrl, apiKey);
      await this.persistStatus(stored, { status: 'ok', statusMessage: null, version, indexerCount });
      await this.audit.record({
        userId: ctx.userId,
        action: 'prowlarr.test',
        objectType: 'setting',
        objectId: SETTINGS_KEY,
        result: 'success',
        metadata: { version },
      });
      return { ok: true, version, indexerCount, message: 'Connected to Prowlarr' };
    } catch (err) {
      const message = (err as Error).message;
      await this.persistStatus(stored, { status: 'error', statusMessage: message });
      await this.audit.record({
        userId: ctx.userId,
        action: 'prowlarr.test',
        objectType: 'setting',
        objectId: SETTINGS_KEY,
        result: 'failure',
        metadata: { message },
      });
      return { ok: false, message };
    }
  }

  /** Live health read used by the status endpoint (no audit — polled by the UI). */
  async status() {
    const stored = await this.loadRaw();
    const decrypted = this.decryptConfig(stored);
    const enabled = !!stored.enabled;
    const apiKey = (decrypted.apiKey as string) || '';
    const internalUrl = (decrypted.internalUrl as string) || DEFAULT_INTERNAL_URL;

    if (!enabled || !apiKey) {
      return {
        status: enabled ? 'unconfigured' : 'disabled',
        version: (stored.version as string) ?? null,
        indexerCount: (stored.indexerCount as number) ?? null,
        lastCheckedAt: (stored.lastCheckedAt as string) ?? null,
        message: enabled ? 'API key not set' : 'Prowlarr integration is disabled',
      };
    }

    try {
      const { version, indexerCount } = await this.probe(internalUrl, apiKey);
      await this.persistStatus(stored, { status: 'ok', statusMessage: null, version, indexerCount });
      return { status: 'ok', version, indexerCount, lastCheckedAt: new Date().toISOString(), message: 'Connected' };
    } catch (err) {
      const message = (err as Error).message;
      await this.persistStatus(stored, { status: 'error', statusMessage: message });
      return {
        status: 'error',
        version: (stored.version as string) ?? null,
        indexerCount: (stored.indexerCount as number) ?? null,
        lastCheckedAt: new Date().toISOString(),
        message,
      };
    }
  }

  /** Resolve the public URL for the "Open Prowlarr" action, auditing the open. */
  async open(ctx: AuditCtx = {}) {
    const stored = await this.loadRaw();
    const url = (stored.publicUrl as string) || DEFAULT_PUBLIC_URL;
    await this.audit.record({
      userId: ctx.userId,
      action: 'prowlarr.opened',
      objectType: 'setting',
      objectId: SETTINGS_KEY,
    });
    return { url };
  }

  // --- outbound calls (SSRF-guarded, never logged) --------------------------

  private async probe(
    internalUrl: string,
    apiKey: string,
  ): Promise<{ version: string | null; indexerCount: number | null }> {
    const base = parseProwlarrUrl(internalUrl);
    await assertNotMetadata(base);

    const statusRes = await this.call(base, '/api/v1/system/status', apiKey);
    if (statusRes.status === 401 || statusRes.status === 403) {
      throw new BadRequestException('Prowlarr rejected the API key');
    }
    if (!statusRes.ok) {
      throw new BadRequestException(`Prowlarr returned HTTP ${statusRes.status}`);
    }
    const status = await this.readJson(statusRes);
    const version = (status?.version as string) ?? null;

    // Best-effort indexer count for the summary; a failure here is non-fatal.
    let indexerCount: number | null = null;
    try {
      const idxRes = await this.call(base, '/api/v1/indexer', apiKey);
      if (idxRes.ok) {
        const arr = await this.readJson(idxRes);
        if (Array.isArray(arr)) indexerCount = arr.length;
      }
    } catch {
      /* summary is optional */
    }
    return { version, indexerCount };
  }

  private async call(base: URL, path: string, apiKey: string): Promise<Response> {
    // Preserve any base-path (reverse-proxy subpath) by concatenating, and never
    // log the URL or key. `redirect: 'error'` blocks a bounce to an internal host.
    const url = `${base.toString().replace(/\/$/, '')}${path}`;
    return fetch(url, {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err) => {
      throw new BadRequestException(`Could not reach Prowlarr: ${(err as Error).message}`);
    });
  }

  private async readJson(res: Response): Promise<any> {
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared && declared > MAX_RESPONSE_BYTES) {
      throw new BadRequestException('Prowlarr response too large');
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new BadRequestException('Prowlarr response too large');
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Patch only the status/health fields onto the raw (still-encrypted) blob. */
  private async persistStatus(
    raw: Stored,
    patch: { status: string; statusMessage: string | null; version?: string | null; indexerCount?: number | null },
  ): Promise<void> {
    const next: Stored = { ...raw };
    next.status = patch.status;
    next.statusMessage = patch.statusMessage;
    if (patch.version !== undefined) next.version = patch.version;
    if (patch.indexerCount !== undefined) next.indexerCount = patch.indexerCount;
    next.lastCheckedAt = new Date().toISOString();
    await this.persist(next);
  }
}
