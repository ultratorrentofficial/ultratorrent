import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.module';
import { SecretCipher } from '../../common/crypto/secret-cipher';

/** Settings key under which the GeoIP downloader config lives. */
export const GEOIP_SETTINGS_KEY = 'geoip.config';

/** Returned to a client in place of the stored licence key. */
export const REDACTED = '••••••••';

/** The editions the downloader knows how to fetch. City is required for locations. */
export const KNOWN_EDITIONS = ['GeoLite2-City', 'GeoLite2-ASN'] as const;
export type GeoIpEdition = (typeof KNOWN_EDITIONS)[number];

/** The GeoIP downloader configuration (decrypted, in-memory shape). */
export interface GeoIpSettings {
  /** MaxMind account id. */
  accountId: string | null;
  /** Decrypted licence key — NEVER returned to a client or logged. */
  licenseKey: string | null;
  /** When true, a scheduled job refreshes the databases automatically. */
  autoUpdate: boolean;
  /** Hours between auto-update checks (minimum 1). MaxMind refreshes ~2×/week. */
  updateIntervalHours: number;
  /** Which editions to keep current. */
  editions: GeoIpEdition[];
}

/** Client-safe view: licence key redacted, presence flagged. */
export interface RedactedGeoIpSettings extends Omit<GeoIpSettings, 'licenseKey'> {
  licenseKey: string | null;
  hasLicenseKey: boolean;
}

export interface GeoIpSettingsPatch {
  accountId?: string | null;
  licenseKey?: string | null;
  autoUpdate?: boolean;
  updateIntervalHours?: number;
  editions?: string[];
}

const DEFAULTS: GeoIpSettings = {
  accountId: null,
  licenseKey: null,
  autoUpdate: false,
  updateIntervalHours: 72,
  editions: ['GeoLite2-City', 'GeoLite2-ASN'],
};

/**
 * Reads/writes the GeoIP downloader settings via the generic settings service,
 * exactly as the IMDb provider does its API key: the MaxMind licence key is
 * AES-GCM encrypted at rest (SecretCipher) and never returned to a client
 * (redacted) or logged.
 */
@Injectable()
export class GeoIpSettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly cipher: SecretCipher,
  ) {}

  async read(): Promise<GeoIpSettings> {
    const stored = (await this.settings.get<Record<string, unknown>>(GEOIP_SETTINGS_KEY)) ?? {};
    const encrypted = Boolean((stored as Record<string, unknown>).__licenseKeyEncrypted);
    let licenseKey: string | null = null;
    const raw = (stored as Record<string, unknown>).licenseKey;
    if (typeof raw === 'string' && raw) {
      if (encrypted) {
        try {
          licenseKey = this.cipher.decrypt(raw);
        } catch {
          licenseKey = null; // rotated/corrupt key — fail closed
        }
      } else {
        licenseKey = raw;
      }
    }
    return {
      accountId: str((stored as Record<string, unknown>).accountId),
      licenseKey,
      autoUpdate: bool((stored as Record<string, unknown>).autoUpdate, DEFAULTS.autoUpdate),
      updateIntervalHours: Math.max(
        1,
        num((stored as Record<string, unknown>).updateIntervalHours, DEFAULTS.updateIntervalHours),
      ),
      editions: cleanEditions((stored as Record<string, unknown>).editions) ?? DEFAULTS.editions,
    };
  }

  async readRedacted(): Promise<RedactedGeoIpSettings> {
    const s = await this.read();
    return { ...s, licenseKey: s.licenseKey ? REDACTED : null, hasLicenseKey: Boolean(s.licenseKey) };
  }

  /** True when both credentials are present — the downloader needs both. */
  async isConfigured(): Promise<boolean> {
    const s = await this.read();
    return Boolean(s.accountId && s.licenseKey);
  }

  async update(patch: GeoIpSettingsPatch): Promise<RedactedGeoIpSettings> {
    const current = await this.read();

    if (
      patch.updateIntervalHours !== undefined &&
      (!Number.isFinite(patch.updateIntervalHours) || patch.updateIntervalHours < 1)
    ) {
      throw new BadRequestException('updateIntervalHours must be at least 1.');
    }
    let editions = current.editions;
    if (patch.editions !== undefined) {
      const cleaned = cleanEditions(patch.editions);
      if (!cleaned || cleaned.length === 0) {
        throw new BadRequestException('At least one valid edition is required (GeoLite2-City is recommended).');
      }
      editions = cleaned;
    }

    const next: GeoIpSettings = {
      accountId: normOpt(patch.accountId, current.accountId),
      licenseKey: resolveKey(patch.licenseKey, current.licenseKey),
      autoUpdate: patch.autoUpdate ?? current.autoUpdate,
      updateIntervalHours: patch.updateIntervalHours ?? current.updateIntervalHours,
      editions,
    };

    await this.settings.set(GEOIP_SETTINGS_KEY, {
      accountId: next.accountId,
      autoUpdate: next.autoUpdate,
      updateIntervalHours: next.updateIntervalHours,
      editions: next.editions,
      licenseKey: next.licenseKey ? this.cipher.encrypt(next.licenseKey) : null,
      __licenseKeyEncrypted: Boolean(next.licenseKey),
    });
    return this.readRedacted();
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}
function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function normOpt(patch: string | null | undefined, current: string | null): string | null {
  if (patch === undefined) return current;
  if (patch === null) return null;
  const t = patch.trim();
  return t ? t : null;
}
/** Undefined/REDACTED = keep current; null/'' = clear; else new key. */
function resolveKey(patch: string | null | undefined, current: string | null): string | null {
  if (patch === undefined || patch === REDACTED) return current;
  if (patch === null) return null;
  const t = patch.trim();
  return t ? t : null;
}
/** Keep only editions the downloader understands, de-duplicated in order. */
function cleanEditions(v: unknown): GeoIpEdition[] | null {
  if (!Array.isArray(v)) return null;
  const out: GeoIpEdition[] = [];
  for (const item of v) {
    if (typeof item === 'string' && (KNOWN_EDITIONS as readonly string[]).includes(item)) {
      const e = item as GeoIpEdition;
      if (!out.includes(e)) out.push(e);
    }
  }
  return out;
}
