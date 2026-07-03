import { Injectable } from '@nestjs/common';
import {
  LicenseProvider,
  LicenseStatus,
  ModuleManifest,
} from '@ultratorrent/shared';
import { ALL_MANIFESTS } from './manifests';

/** DI token for the module-availability provider. */
export const LICENSE_PROVIDER = Symbol('MODULE_AVAILABILITY_PROVIDER');

/**
 * Single-tier availability provider. UltraTorrent ships one community edition in
 * which every module is `core`/`community` and therefore always available. The
 * registry consults this seam so the rule lives in one place.
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
      modules: ['*'], // every module is available
      issuedAt: null,
      expiresAt: null,
      expired: false,
    };
  }

  async hasModule(moduleId: string): Promise<boolean> {
    const tier = this.tierById.get(moduleId);
    // Unknown ids (e.g. an external module key) are treated as not-available.
    return tier === 'core' || tier === 'community';
  }

  async getModuleLimits(): Promise<Record<string, unknown>> {
    return {};
  }

  async getGlobalLimits(): Promise<Record<string, unknown>> {
    return {};
  }
}
