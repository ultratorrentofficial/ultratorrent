import { Injectable } from '@nestjs/common';
import {
  LicenseProvider,
  LicenseStatus,
  ModuleManifest,
} from '@ultratorrent/shared';
import { ALL_MANIFESTS } from './manifests';

/** DI token for the active {@link LicenseProvider}. */
export const LICENSE_PROVIDER = Symbol('LICENSE_PROVIDER');

/**
 * Default, no-license-file provider for the public Core. It permits every
 * `core` and `community` module and denies `premium`/`enterprise`. The private
 * Enterprise overlay binds a UPLM-backed provider to {@link LICENSE_PROVIDER}
 * to unlock the higher tiers — Core never needs to know how.
 */
@Injectable()
export class CommunityLicenseProvider implements LicenseProvider {
  private readonly tierById = new Map<string, ModuleManifest['tier']>(
    ALL_MANIFESTS.map((m) => [m.id, m.tier]),
  );

  async getStatus(): Promise<LicenseStatus> {
    return {
      edition: 'community',
      valid: true,
      licensee: null,
      modules: [], // no premium/enterprise unlocks
      issuedAt: null,
      expiresAt: null,
      expired: false,
    };
  }

  async hasModule(moduleId: string): Promise<boolean> {
    const tier = this.tierById.get(moduleId);
    // Unknown ids (e.g. an external module key) are treated as not-permitted.
    return tier === 'core' || tier === 'community';
  }

  async getModuleLimits(): Promise<Record<string, unknown>> {
    return {};
  }

  async getGlobalLimits(): Promise<Record<string, unknown>> {
    return {};
  }
}
