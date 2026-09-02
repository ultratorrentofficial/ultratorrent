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
 * Availability provider. UltraTorrent ships a single community edition in which
 * every module is available, so this answers "is this a module we know about"
 * and nothing more. The registry consults it as a seam, keeping the rule in one
 * place rather than scattering an `always true` through the callers.
 */
@Injectable()
export class CommunityLicenseProvider implements LicenseProvider {
  private readonly knownIds = new Set<string>(ALL_MANIFESTS.map((m) => m.id));

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
    /*
     * Every module ships in the one community build, so availability is only ever
     * "is this a module we know about". This used to compare a tier against the
     * two values it could hold and return true for both — a licensing check that
     * had stopped checking anything.
     */
    return this.knownIds.has(moduleId);
  }

  async getModuleLimits(): Promise<Record<string, unknown>> {
    return {};
  }

  async getGlobalLimits(): Promise<Record<string, unknown>> {
    return {};
  }
}
