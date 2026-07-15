/**
 * Reads/writes per-provider configuration (SubtitleProviderConfig rows).
 *
 * Secret keys (apiKey / username / password / token) are AES-256-GCM encrypted at
 * rest via SecretCipher and NEVER returned to a client — `list()` redacts them to
 * `••••••••`. On update, a value that is only `•` characters means "keep the
 * stored secret", so the UI can round-trip a redacted config without wiping keys
 * (the same contract the media-server integrations use).
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type SubtitleProviderConfig } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../../common/crypto/secret-cipher';

export const REDACTED = '••••••••';
const SECRET_KEYS = new Set(['apiKey', 'username', 'password', 'token']);

/** A provider config with secrets decrypted for internal use. */
export interface DecryptedProviderConfig {
  provider: string;
  isEnabled: boolean;
  priority: number;
  config: Record<string, unknown>;
  healthy: boolean | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  quotaRemaining: number | null;
  quotaResetAt: Date | null;
}

export interface ProviderConfigPatch {
  isEnabled?: boolean;
  priority?: number;
  config?: Record<string, unknown>;
}

const isRedacted = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && /^•+$/.test(v);

@Injectable()
export class SubtitleProviderSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
  ) {}

  /** Decrypt a stored row's secret keys for provider use. */
  private decrypt(row: SubtitleProviderConfig): DecryptedProviderConfig {
    const stored = (row.config ?? {}) as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored)) {
      if (SECRET_KEYS.has(k) && typeof v === 'string' && v) {
        try {
          config[k] = this.cipher.decrypt(v);
        } catch {
          config[k] = null; // rotated/corrupt key — fail closed
        }
      } else {
        config[k] = v;
      }
    }
    return {
      provider: row.provider,
      isEnabled: row.isEnabled,
      priority: row.priority,
      config,
      healthy: row.healthy,
      lastCheckedAt: row.lastCheckedAt,
      lastError: row.lastError,
      quotaRemaining: row.quotaRemaining,
      quotaResetAt: row.quotaResetAt,
    };
  }

  /** Redact secrets from a config for API responses. */
  private redact(row: SubtitleProviderConfig) {
    const stored = (row.config ?? {}) as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored)) {
      config[k] = SECRET_KEYS.has(k) && typeof v === 'string' && v ? REDACTED : v;
    }
    const { config: _c, ...rest } = row;
    return { ...rest, config };
  }

  /** All provider rows with secrets redacted (safe to return to a client). */
  async list() {
    const rows = await this.prisma.subtitleProviderConfig.findMany({ orderBy: { provider: 'asc' } });
    return rows.map((r) => this.redact(r));
  }

  /** One provider's decrypted config for internal use (null when absent). */
  async read(provider: string): Promise<DecryptedProviderConfig | null> {
    const row = await this.prisma.subtitleProviderConfig.findUnique({ where: { provider } });
    return row ? this.decrypt(row) : null;
  }

  /** All enabled providers, decrypted, in priority order (highest first). */
  async readEnabled(): Promise<DecryptedProviderConfig[]> {
    const rows = await this.prisma.subtitleProviderConfig.findMany({
      where: { isEnabled: true },
      orderBy: [{ priority: 'desc' }, { provider: 'asc' }],
    });
    return rows.map((r) => this.decrypt(r));
  }

  /**
   * Create/update a provider config, encrypting secret keys. A redacted secret
   * value (all `•`) is dropped so the stored ciphertext is kept.
   */
  async upsert(provider: string, patch: ProviderConfigPatch) {
    const existing = await this.prisma.subtitleProviderConfig.findUnique({ where: { provider } });
    const storedConfig = (existing?.config ?? {}) as Record<string, unknown>;
    const nextConfig: Record<string, unknown> = { ...storedConfig };

    if (patch.config) {
      for (const [k, v] of Object.entries(patch.config)) {
        if (SECRET_KEYS.has(k)) {
          if (isRedacted(v)) continue; // keep existing ciphertext
          if (v === '' || v == null) {
            delete nextConfig[k]; // explicit clear
          } else {
            nextConfig[k] = this.cipher.encrypt(String(v));
          }
        } else {
          nextConfig[k] = v;
        }
      }
    }

    const row = await this.prisma.subtitleProviderConfig.upsert({
      where: { provider },
      create: {
        provider,
        isEnabled: patch.isEnabled ?? false,
        priority: patch.priority ?? 0,
        config: nextConfig as Prisma.InputJsonValue,
      },
      update: {
        ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        config: nextConfig as Prisma.InputJsonValue,
      },
    });
    return this.redact(row);
  }

  /** Record the outcome of a health check (never carries secrets). */
  async recordHealth(
    provider: string,
    health: { healthy: boolean; message?: string; quotaRemaining?: number | null; quotaResetAt?: Date | null },
  ) {
    await this.prisma.subtitleProviderConfig.updateMany({
      where: { provider },
      data: {
        healthy: health.healthy,
        lastError: health.healthy ? null : (health.message ?? 'unhealthy'),
        lastCheckedAt: new Date(),
        ...(health.quotaRemaining !== undefined ? { quotaRemaining: health.quotaRemaining } : {}),
        ...(health.quotaResetAt !== undefined ? { quotaResetAt: health.quotaResetAt } : {}),
      },
    });
  }
}
