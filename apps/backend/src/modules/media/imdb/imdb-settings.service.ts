import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.module';
import { SecretCipher } from '../../../common/crypto/secret-cipher';
import { DEFAULT_IMDB_DATASET_BASE_URL } from './imdb-tsv';

/** Settings key under which the IMDb provider config lives. */
export const IMDB_SETTINGS_KEY = 'media.imdb';

export type ImdbMode = 'disabled' | 'dataset' | 'official_api' | 'hybrid';
const MODES: ImdbMode[] = ['disabled', 'dataset', 'official_api', 'hybrid'];

/** Redaction placeholder returned to clients in place of a stored secret. */
export const REDACTED = '••••••••';

/** The IMDb provider configuration (decrypted, in-memory shape). */
export interface ImdbSettings {
  mode: ImdbMode;
  apiBaseUrl: string | null;
  /** Decrypted API key — NEVER returned to a client or logged. */
  apiKey: string | null;
  datasetPath: string | null;
  importSchedule: string | null;
  /** When true, a scheduled job downloads + imports the datasets automatically. */
  autoDownloadEnabled: boolean;
  /** Base URL the dataset files are fetched from (defaults to official IMDb). */
  datasetBaseUrl: string;
  /** How often the auto-update job runs, in hours (minimum 1). */
  autoUpdateIntervalHours: number;
  preferredRegion: string | null;
  preferredLanguage: string | null;
  includeAdult: boolean;
  minVotes: number;
  cacheTtl: number;
}

/** The client-safe view: identical shape but with the secret redacted. */
export interface RedactedImdbSettings extends Omit<ImdbSettings, 'apiKey'> {
  apiKey: string | null;
  /** True when an API key is configured (without revealing it). */
  hasApiKey: boolean;
}

/** Patch accepted from the configure endpoint. */
export interface ImdbSettingsPatch {
  mode?: ImdbMode;
  apiBaseUrl?: string | null;
  apiKey?: string | null;
  datasetPath?: string | null;
  importSchedule?: string | null;
  autoDownloadEnabled?: boolean;
  datasetBaseUrl?: string | null;
  autoUpdateIntervalHours?: number;
  preferredRegion?: string | null;
  preferredLanguage?: string | null;
  includeAdult?: boolean;
  minVotes?: number;
  cacheTtl?: number;
}

const DEFAULTS: ImdbSettings = {
  mode: 'disabled',
  apiBaseUrl: null,
  apiKey: null,
  datasetPath: null,
  importSchedule: null,
  autoDownloadEnabled: false,
  datasetBaseUrl: DEFAULT_IMDB_DATASET_BASE_URL,
  autoUpdateIntervalHours: 168,
  preferredRegion: null,
  preferredLanguage: null,
  includeAdult: false,
  minVotes: 0,
  cacheTtl: 3600,
};

/**
 * Reads/writes the IMDb provider settings via the generic settings service. The
 * API key is AES-GCM encrypted at rest (SecretCipher) and is never returned to a
 * client (redacted) or written to logs.
 */
@Injectable()
export class ImdbSettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly cipher: SecretCipher,
  ) {}

  /** Read the stored (encrypted) blob and decrypt the API key for internal use. */
  async read(): Promise<ImdbSettings> {
    const stored =
      (await this.settings.get<Record<string, unknown>>(IMDB_SETTINGS_KEY)) ?? {};
    const encrypted = Boolean((stored as any).__apiKeyEncrypted);
    let apiKey: string | null = null;
    const rawKey = (stored as any).apiKey;
    if (typeof rawKey === 'string' && rawKey) {
      if (encrypted) {
        try {
          apiKey = this.cipher.decrypt(rawKey);
        } catch {
          apiKey = null; // rotated/corrupt key — fail closed
        }
      } else {
        apiKey = rawKey;
      }
    }
    return {
      mode: MODES.includes((stored as any).mode) ? (stored as any).mode : DEFAULTS.mode,
      apiBaseUrl: str((stored as any).apiBaseUrl),
      apiKey,
      datasetPath: str((stored as any).datasetPath),
      importSchedule: str((stored as any).importSchedule),
      autoDownloadEnabled: bool((stored as any).autoDownloadEnabled, DEFAULTS.autoDownloadEnabled),
      datasetBaseUrl: str((stored as any).datasetBaseUrl) ?? DEFAULTS.datasetBaseUrl,
      autoUpdateIntervalHours: Math.max(
        1,
        num((stored as any).autoUpdateIntervalHours, DEFAULTS.autoUpdateIntervalHours),
      ),
      preferredRegion: str((stored as any).preferredRegion),
      preferredLanguage: str((stored as any).preferredLanguage),
      includeAdult: bool((stored as any).includeAdult, DEFAULTS.includeAdult),
      minVotes: num((stored as any).minVotes, DEFAULTS.minVotes),
      cacheTtl: num((stored as any).cacheTtl, DEFAULTS.cacheTtl),
    };
  }

  /** Client-safe read: secret redacted, presence flagged. */
  async readRedacted(): Promise<RedactedImdbSettings> {
    const s = await this.read();
    return {
      ...s,
      apiKey: s.apiKey ? REDACTED : null,
      hasApiKey: Boolean(s.apiKey),
    };
  }

  /**
   * Apply a patch and persist. The API key is encrypted; an incoming REDACTED
   * placeholder means "keep the existing key" (so a redacted read can be echoed
   * back without wiping the secret). Returns the redacted, updated settings.
   *
   * NOTE: datasetPath containment is NOT enforced here — callers must validate
   * it via FilePathService before invoking, so this stays free of fs concerns.
   */
  async update(patch: ImdbSettingsPatch): Promise<RedactedImdbSettings> {
    const current = await this.read();

    if (patch.mode !== undefined && !MODES.includes(patch.mode)) {
      throw new BadRequestException(`Invalid IMDb mode "${patch.mode}".`);
    }
    if (patch.minVotes !== undefined && (patch.minVotes < 0 || !Number.isFinite(patch.minVotes))) {
      throw new BadRequestException('minVotes must be a non-negative number.');
    }
    if (patch.cacheTtl !== undefined && (patch.cacheTtl < 0 || !Number.isFinite(patch.cacheTtl))) {
      throw new BadRequestException('cacheTtl must be a non-negative number.');
    }
    if (
      patch.autoUpdateIntervalHours !== undefined &&
      (!Number.isFinite(patch.autoUpdateIntervalHours) || patch.autoUpdateIntervalHours < 1)
    ) {
      throw new BadRequestException('autoUpdateIntervalHours must be at least 1.');
    }
    if (patch.datasetBaseUrl != null && patch.datasetBaseUrl !== '') {
      assertHttpUrl(patch.datasetBaseUrl);
    }

    const next: ImdbSettings = {
      mode: patch.mode ?? current.mode,
      apiBaseUrl: normOpt(patch.apiBaseUrl, current.apiBaseUrl),
      apiKey: resolveKey(patch.apiKey, current.apiKey),
      datasetPath: normOpt(patch.datasetPath, current.datasetPath),
      importSchedule: normOpt(patch.importSchedule, current.importSchedule),
      autoDownloadEnabled: patch.autoDownloadEnabled ?? current.autoDownloadEnabled,
      // Undefined = keep; null/'' = reset to the official default (never empty).
      datasetBaseUrl:
        patch.datasetBaseUrl === undefined
          ? current.datasetBaseUrl
          : normOpt(patch.datasetBaseUrl, current.datasetBaseUrl) ?? DEFAULTS.datasetBaseUrl,
      autoUpdateIntervalHours:
        patch.autoUpdateIntervalHours ?? current.autoUpdateIntervalHours,
      preferredRegion: normOpt(patch.preferredRegion, current.preferredRegion),
      preferredLanguage: normOpt(patch.preferredLanguage, current.preferredLanguage),
      includeAdult: patch.includeAdult ?? current.includeAdult,
      minVotes: patch.minVotes ?? current.minVotes,
      cacheTtl: patch.cacheTtl ?? current.cacheTtl,
    };

    const toStore: Record<string, unknown> = {
      mode: next.mode,
      apiBaseUrl: next.apiBaseUrl,
      datasetPath: next.datasetPath,
      importSchedule: next.importSchedule,
      autoDownloadEnabled: next.autoDownloadEnabled,
      datasetBaseUrl: next.datasetBaseUrl,
      autoUpdateIntervalHours: next.autoUpdateIntervalHours,
      preferredRegion: next.preferredRegion,
      preferredLanguage: next.preferredLanguage,
      includeAdult: next.includeAdult,
      minVotes: next.minVotes,
      cacheTtl: next.cacheTtl,
      apiKey: next.apiKey ? this.cipher.encrypt(next.apiKey) : null,
      __apiKeyEncrypted: Boolean(next.apiKey),
    };
    await this.settings.set(IMDB_SETTINGS_KEY, toStore);
    return this.readRedacted();
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
/** Assert a string is an absolute http(s) URL (SSRF guard for the base URL). */
function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('datasetBaseUrl must be a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException('datasetBaseUrl must be an http(s) URL.');
  }
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}
function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
/** Undefined = keep current; null/'' = clear; else trimmed value. */
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
