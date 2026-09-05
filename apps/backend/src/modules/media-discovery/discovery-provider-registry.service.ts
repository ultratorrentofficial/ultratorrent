import { Injectable, Logger } from '@nestjs/common';
import type { DiscoveryCapability } from '@ultratorrent/shared';
import type { DiscoveryProviderHealth, ReleaseDiscoveryProvider } from './discovery-provider';

/**
 * The set of discovery providers, routed by capability.
 *
 * Mirrors {@link MetadataProviderRegistry}, with one deliberate difference: the
 * metadata registry builds a CHAIN and stops at the first provider that answers,
 * because there is one right answer to "what is this file". Discovery is the
 * opposite — every provider that can answer should, because the point is to see
 * a title TMDB has and TVmaze does not, and vice versa. Merging their answers is
 * a later step, and it needs all of them.
 *
 * Registration is explicit rather than by module scanning: a provider that is
 * present but not configured must not silently join a sync.
 */
@Injectable()
export class DiscoveryProviderRegistry {
  private readonly logger = new Logger(DiscoveryProviderRegistry.name);
  private readonly providers = new Map<string, ReleaseDiscoveryProvider>();

  register(provider: ReleaseDiscoveryProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): ReleaseDiscoveryProvider | undefined {
    return this.providers.get(name);
  }

  all(): ReleaseDiscoveryProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Providers that can answer `capability`, optionally narrowed to the names a
   * template selected.
   *
   * A template naming a provider that is not registered gets silence from it
   * rather than an error: a provider can be removed or left unconfigured, and
   * that must not break every template that once referenced it.
   */
  supporting(capability: DiscoveryCapability, names?: string[]): ReleaseDiscoveryProvider[] {
    const wanted = names?.length ? new Set(names) : null;
    return this.all().filter(
      (p) => (!wanted || wanted.has(p.name)) && p.capabilities().includes(capability),
    );
  }

  /**
   * Health for every registered provider.
   *
   * A provider that throws from its own `healthCheck` is reported unhealthy
   * rather than being allowed to fail the whole status call — the one place an
   * operator looks to find out which provider is broken must not itself break
   * because a provider is broken.
   */
  async health(): Promise<Record<string, DiscoveryProviderHealth>> {
    const out: Record<string, DiscoveryProviderHealth> = {};
    for (const p of this.all()) {
      try {
        out[p.name] = await p.healthCheck();
      } catch (err) {
        this.logger.warn(`Discovery provider ${p.name} health check threw: ${(err as Error).message}`);
        out[p.name] = { healthy: false, message: 'Health check failed' };
      }
    }
    return out;
  }
}
