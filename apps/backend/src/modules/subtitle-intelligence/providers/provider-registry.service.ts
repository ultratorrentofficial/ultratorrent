/**
 * Builds the set of live SubtitleProviders from stored config. Business logic
 * depends on the SubtitleProvider interface only; this is the sole place that
 * knows concrete provider classes, so adding SubDL / Local / Addic7ed later is a
 * one-line `construct()` case with no engine changes.
 */
import { Injectable } from '@nestjs/common';
import { FilePathService } from '../../files/file-path.service';
import type { SubtitleProvider } from './subtitle-provider';
import {
  DecryptedProviderConfig,
  SubtitleProviderSettingsService,
} from './subtitle-provider-settings.service';
import { OpenSubtitlesConfig, OpenSubtitlesProvider } from './opensubtitles.provider';
import { SubDLConfig, SubDLProvider } from './subdl.provider';
import { LocalRepoConfig, LocalRepositoryProvider } from './local-repository.provider';
import { YifyProvider } from './yify.provider';
import { SubtitleCatProvider } from './subtitlecat.provider';
import { PodnapisiProvider } from './podnapisi.provider';

/** Static catalog entry — drives the Providers UI even before a provider is configured. */
export interface ProviderCatalogEntry {
  key: string;
  label: string;
  /** Concrete implementation exists (vs interface prepared for a future phase). */
  implemented: boolean;
  /** Secret config fields the UI should render as password inputs. */
  secretFields: string[];
  /** Non-secret config fields (e.g. a local repo path). */
  fields: string[];
}

/** Every provider UltraTorrent knows about; `implemented` gates whether it runs. */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { key: 'opensubtitles', label: 'OpenSubtitles', implemented: true, secretFields: ['apiKey', 'username', 'password'], fields: [] },
  { key: 'subdl', label: 'SubDL', implemented: true, secretFields: ['apiKey'], fields: [] },
  { key: 'local', label: 'Local Subtitle Repository', implemented: true, secretFields: [], fields: ['repoPath'] },
  { key: 'podnapisi', label: 'Podnapisi', implemented: true, secretFields: [], fields: [] },
  { key: 'yify', label: 'YIFY Subtitles', implemented: true, secretFields: [], fields: [] },
  { key: 'subtitlecat', label: 'SubtitleCat', implemented: true, secretFields: [], fields: [] },
  { key: 'addic7ed', label: 'Addic7ed', implemented: false, secretFields: ['username', 'password'], fields: [] },
  { key: 'subs4free', label: 'Subs4Free', implemented: false, secretFields: [], fields: [] },
];

@Injectable()
export class SubtitleProviderRegistry {
  constructor(
    private readonly settings: SubtitleProviderSettingsService,
    private readonly filePath: FilePathService,
  ) {}

  /** Construct a provider from its decrypted config, or null if not implemented. */
  private construct(c: DecryptedProviderConfig): SubtitleProvider | null {
    switch (c.provider) {
      case 'opensubtitles':
        return new OpenSubtitlesProvider(c.config as OpenSubtitlesConfig);
      case 'subdl':
        return new SubDLProvider(c.config as SubDLConfig);
      case 'local':
        // The local provider reads the filesystem — hand it the hard-root guard.
        return new LocalRepositoryProvider(c.config as LocalRepoConfig, this.filePath);
      case 'podnapisi':
        return new PodnapisiProvider();
      case 'yify':
        return new YifyProvider();
      case 'subtitlecat':
        return new SubtitleCatProvider();
      // addic7ed / subs4free land later behind the same interface.
      default:
        return null;
    }
  }

  /** All enabled + validly-configured providers, in priority order. */
  async build(): Promise<SubtitleProvider[]> {
    const configs = await this.settings.readEnabled();
    const providers: SubtitleProvider[] = [];
    for (const c of configs) {
      const p = this.construct(c);
      if (p && p.validateConfiguration()) providers.push(p);
    }
    return providers;
  }

  /** A single provider by key (enabled or not), for a test/health call. */
  async get(provider: string): Promise<SubtitleProvider | null> {
    const c = await this.settings.read(provider);
    return c ? this.construct(c) : null;
  }
}
