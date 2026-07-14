/**
 * The metadata provider registry.
 *
 * Before this, metadata resolution was a single hard-coded choice — "TMDB if a
 * key is set, otherwise offline" — which meant a TMDB miss was simply a miss,
 * and a second source could not be added without editing the call site. The
 * registry replaces that with an ordered CHAIN of configured providers, and is
 * the foundation the Universal scraper (per-field composition across providers)
 * and Trakt (which needs per-provider ids to sync anything) both stand on.
 *
 * Two things it deliberately owns:
 *
 * 1. **Instance lifetime.** Providers are cached and reused, keyed by their
 *    config. TVDB authenticates once and reuses a bearer token for weeks —
 *    constructing a provider per lookup (as the old code did for TMDB) would
 *    pay for a fresh login on every item in a 29,000-file library.
 *
 * 2. **Order per kind.** TVDB is the stronger source for television (it is the
 *    only one publishing aired/DVD/absolute episode orderings); TMDB is the
 *    stronger source for film. So the default chain is kind-dependent rather
 *    than one global ranking, and either can be overridden by config.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.module';
import {
  LocalMetadataProvider,
  TmdbMetadataProvider,
  type MediaLookup,
  type MediaMetadataProvider,
} from './metadata-provider';
import { TvdbMetadataProvider } from './tvdb-metadata.provider';
import { UniversalMetadataProvider, type FieldPolicy } from './universal-metadata.provider';

/** Default chains. TV leans TVDB-first; film leans TMDB-first. */
export const DEFAULT_ORDER: Record<'tv' | 'movie', string[]> = {
  tv: ['tvdb', 'tmdb'],
  movie: ['tmdb', 'tvdb'],
};

export interface ProviderConfig {
  tmdbApiKey?: string;
  tvdbApiKey?: string;
  tvdbPin?: string;
  /** Explicit chain; overrides the per-kind defaults for every kind when set. */
  order?: string[];
  /**
   * The Universal scraper: compose ONE record per item from every configured
   * provider, field by field, instead of taking the first provider that answers.
   * Off by default — it queries every provider for every item, where the plain
   * chain usually stops at the first.
   */
  universalEnabled?: boolean;
  /** field → preferred provider for Universal. Unset fields use chain order. */
  universalFields?: FieldPolicy;
}

/**
 * Resolve the configured chain for a lookup: the named providers that are
 * actually configured, in order, with unknown/unconfigured names dropped. Pure —
 * exported so the ordering rules are testable without settings or network.
 */
export function resolveChain(kind: MediaLookup['kind'], config: ProviderConfig): string[] {
  const isEpisodic = kind === 'tv' || kind === 'anime';
  const wanted = config.order?.length
    ? config.order
    : DEFAULT_ORDER[isEpisodic ? 'tv' : 'movie'];
  const configured = (name: string): boolean => {
    if (name === 'tmdb') return Boolean(config.tmdbApiKey);
    if (name === 'tvdb') return Boolean(config.tvdbApiKey);
    return false;
  };
  return wanted.filter(configured);
}

@Injectable()
export class MetadataProviderRegistry {
  private readonly logger = new Logger(MetadataProviderRegistry.name);
  /** Cached instances, keyed by the config that produced them. */
  private readonly cache = new Map<string, MediaMetadataProvider>();
  private readonly local = new LocalMetadataProvider();

  constructor(private readonly settings: SettingsService) {}

  /** Current provider config, from settings with an env fallback. */
  async config(): Promise<ProviderConfig> {
    const [tmdbApiKey, tvdbApiKey, tvdbPin, order, universalEnabled, universalFields] =
      await Promise.all([
        this.settings.get<string>('media.tmdbApiKey'),
        this.settings.get<string>('media.tvdbApiKey'),
        this.settings.get<string>('media.tvdbPin'),
        this.settings.get<string[]>('media.metadataProviderOrder'),
        this.settings.get<boolean>('media.universalScraper.enabled'),
        this.settings.get<FieldPolicy>('media.universalScraper.fields'),
      ]);
    return {
      tmdbApiKey: tmdbApiKey ?? process.env.TMDB_API_KEY,
      tvdbApiKey: tvdbApiKey ?? process.env.TVDB_API_KEY,
      tvdbPin: tvdbPin ?? process.env.TVDB_PIN,
      order: Array.isArray(order) && order.length ? order : undefined,
      universalEnabled: universalEnabled === true,
      universalFields:
        universalFields && typeof universalFields === 'object' ? universalFields : {},
    };
  }

  /**
   * Build (or reuse) a provider by name. Returns null when it isn't configured.
   * The cache key includes the credentials, so rotating a key in Settings yields
   * a new instance rather than a stale one holding a dead token.
   */
  private instance(name: string, config: ProviderConfig): MediaMetadataProvider | null {
    if (name === 'tmdb') {
      if (!config.tmdbApiKey) return null;
      return this.cached(`tmdb:${config.tmdbApiKey}`, () => new TmdbMetadataProvider(config.tmdbApiKey!));
    }
    if (name === 'tvdb') {
      if (!config.tvdbApiKey) return null;
      return this.cached(
        `tvdb:${config.tvdbApiKey}:${config.tvdbPin ?? ''}`,
        () => new TvdbMetadataProvider(config.tvdbApiKey!, config.tvdbPin),
      );
    }
    if (name === 'local') return this.local;
    return null;
  }

  private cached(key: string, make: () => MediaMetadataProvider): MediaMetadataProvider {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const made = make();
    // One instance per credential set; a rotated key strands the old entry, and
    // the map is bounded by how many times an operator edits a key.
    this.cache.set(key, made);
    return made;
  }

  /** The provider named, if configured — used by targeted/manual lookups. */
  async get(name: string): Promise<MediaMetadataProvider | null> {
    return this.instance(name, await this.config());
  }

  /**
   * The ordered chain for this kind of lookup. Empty when nothing is configured
   * — callers fall back to {@link offline}, which keeps the fully-offline
   * (local NFO only) behaviour the renamer has always had.
   *
   * With the Universal scraper on, the chain collapses to a SINGLE composing
   * provider that queries all the others and merges them field by field. The
   * caller's "first provider that answers wins" loop is then correct by
   * construction: there is only one, and it has already consulted everybody.
   */
  async chain(kind: MediaLookup['kind']): Promise<MediaMetadataProvider[]> {
    const config = await this.config();
    const names = resolveChain(kind, config);
    const providers = names
      .map((n) => this.instance(n, config))
      .filter((p): p is MediaMetadataProvider => p !== null);

    // Composing one source is pointless overhead — it can only return what that
    // provider already said — so Universal engages from two providers up.
    if (config.universalEnabled && providers.length > 1) {
      return [new UniversalMetadataProvider(providers, config.universalFields ?? {})];
    }
    return providers;
  }

  /** The offline provider — never null, returns nothing, never throws. */
  offline(): MediaMetadataProvider {
    return this.local;
  }

  /** Names of every configured provider, for display/diagnostics. */
  async configured(): Promise<string[]> {
    const config = await this.config();
    return ['tvdb', 'tmdb'].filter((n) => this.instance(n, config) !== null);
  }
}
