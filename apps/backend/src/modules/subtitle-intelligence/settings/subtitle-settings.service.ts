/**
 * Global (install-wide) Subtitle Intelligence settings — the module-level knobs
 * that are not per-provider (Providers page) or per-library (Languages page).
 * Backed by the generic `settings` table under the `media.subtitles.*` keys, but
 * exposed as a typed object with defaults + coercion so the UI and the engine
 * share one source of truth. These are the automation switches; nothing here
 * changes behaviour until a provider is enabled and a library has a policy.
 */
import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.module';
import { AuditService, type AuditEntry } from '../../audit/audit.service';

type AuditCtx = Pick<AuditEntry, 'userId' | 'ipAddress' | 'userAgent'>;

export const SUBTITLE_SETTING_KEYS = {
  autoDownload: 'media.subtitles.autoDownload',
  autoSync: 'media.subtitles.autoSync',
  autoScanIntervalMinutes: 'media.subtitles.autoScanIntervalMinutes',
  defaultLanguages: 'media.subtitles.defaultLanguages',
} as const;

export interface SubtitleGlobalSettings {
  /** During a missing-subtitle scan, download the best acceptable candidate
   *  (vs only flagging the gap). Off by default. */
  autoDownload: boolean;
  /** After an auto-download, synchronize it to the audio (needs FFsubsync;
   *  no-ops when the binary is absent). Off by default. */
  autoSync: boolean;
  /** How often the background sweep runs, in minutes. 0 = never (manual only). */
  autoScanIntervalMinutes: number;
  /** Fallback preferred languages for libraries that have no explicit policy. */
  defaultLanguages: string[];
}

export const SUBTITLE_SETTINGS_DEFAULTS: SubtitleGlobalSettings = {
  autoDownload: false,
  autoSync: false,
  autoScanIntervalMinutes: 0,
  defaultLanguages: ['en'],
};

/** Clean a language list: lower-cased, trimmed, de-duplicated, non-empty. Pure. */
export function cleanLanguageList(value: unknown, fallback: string[] = []): string[] {
  const arr = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const l = String(v).trim().toLowerCase();
    if (l && !seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out.length ? out : fallback;
}

@Injectable()
export class SubtitleSettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Read the typed, coerced global settings (with defaults). */
  async read(): Promise<SubtitleGlobalSettings> {
    const K = SUBTITLE_SETTING_KEYS;
    return {
      autoDownload: (await this.settings.get<boolean>(K.autoDownload)) === true,
      autoSync: (await this.settings.get<boolean>(K.autoSync)) === true,
      autoScanIntervalMinutes: Math.max(0, Math.floor(Number(await this.settings.get(K.autoScanIntervalMinutes)) || 0)),
      defaultLanguages: cleanLanguageList(await this.settings.get(K.defaultLanguages), SUBTITLE_SETTINGS_DEFAULTS.defaultLanguages),
    };
  }

  /** Apply a partial update (only the provided keys are written) + audit. */
  async update(patch: Partial<SubtitleGlobalSettings>, ctx: AuditCtx = {}): Promise<SubtitleGlobalSettings> {
    const K = SUBTITLE_SETTING_KEYS;
    if (patch.autoDownload !== undefined) await this.settings.set(K.autoDownload, !!patch.autoDownload);
    if (patch.autoSync !== undefined) await this.settings.set(K.autoSync, !!patch.autoSync);
    if (patch.autoScanIntervalMinutes !== undefined) {
      await this.settings.set(K.autoScanIntervalMinutes, Math.max(0, Math.floor(Number(patch.autoScanIntervalMinutes) || 0)));
    }
    if (patch.defaultLanguages !== undefined) {
      await this.settings.set(K.defaultLanguages, cleanLanguageList(patch.defaultLanguages, SUBTITLE_SETTINGS_DEFAULTS.defaultLanguages));
    }
    await this.audit.record({ ...ctx, action: 'subtitle.settings.updated', objectType: 'subtitle_settings', objectId: 'global', metadata: { keys: Object.keys(patch) } });
    return this.read();
  }
}
