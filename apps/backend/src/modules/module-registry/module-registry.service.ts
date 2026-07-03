import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  LicenseProvider,
  ModuleManifest,
  ModuleStatus,
  ModuleStateValue,
} from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ALL_MANIFESTS } from './manifests';
import { LICENSE_PROVIDER } from './community-license.provider';

@Injectable()
export class ModuleRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModuleRegistryService.name);
  private manifests: ModuleManifest[] = [];
  private byId = new Map<string, ModuleManifest>();
  private statuses = new Map<string, ModuleStatus>();

  /** Availability provider. Defaults to the single-tier community provider; an
   *  external module may swap it at bootstrap via setLicenseProvider. */
  private license: LicenseProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(LICENSE_PROVIDER) defaultLicense: LicenseProvider,
  ) {
    this.license = defaultLicense;
  }

  /** Replace the availability provider at runtime (external-module seam). */
  async setLicenseProvider(provider: LicenseProvider): Promise<void> {
    this.license = provider;
    await this.refresh();
  }

  /** The current availability provider. */
  get licenseProvider(): LicenseProvider {
    return this.license;
  }

  async onModuleInit(): Promise<void> {
    this.load(ALL_MANIFESTS);
    await this.refresh();
    this.logger.log(
      `Module registry: ${this.statuses.size} modules, ${this.getEnabled().length} enabled`,
    );
  }

  /** Load + validate manifests (schema, dependency existence, no cycles). */
  load(manifests: ModuleManifest[]): void {
    for (const m of manifests) this.validateManifest(m);
    const byId = new Map(manifests.map((m) => [m.id, m]));
    if (byId.size !== manifests.length) {
      throw new Error('Duplicate module id in manifests');
    }
    for (const m of manifests) {
      for (const dep of m.dependencies) {
        if (!byId.has(dep)) {
          throw new Error(`Module "${m.id}" depends on unknown module "${dep}"`);
        }
      }
    }
    this.detectCycles(manifests, byId);
    this.manifests = manifests;
    this.byId = byId;
  }

  /** Inject an external module manifest at runtime. */
  async registerExternal(manifest: ModuleManifest): Promise<void> {
    this.load([...this.manifests, manifest]);
    await this.refresh();
  }

  private validateManifest(m: ModuleManifest): void {
    const fail = (msg: string) => {
      throw new Error(`Invalid manifest "${m?.id ?? '?'}": ${msg}`);
    };
    if (!m || typeof m !== 'object') fail('not an object');
    if (!m.id || typeof m.id !== 'string') fail('missing id');
    if (!m.name) fail('missing name');
    if (!['core', 'community'].includes(m.tier)) fail('bad tier');
    if (!Array.isArray(m.dependencies)) fail('dependencies must be an array');
    if (!Array.isArray(m.permissions)) fail('permissions must be an array');
    if (typeof m.enabledByDefault !== 'boolean') fail('enabledByDefault must be boolean');
  }

  private detectCycles(manifests: ModuleManifest[], byId: Map<string, ModuleManifest>): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(manifests.map((m) => [m.id, WHITE]));
    const visit = (id: string, stack: string[]) => {
      color.set(id, GRAY);
      for (const dep of byId.get(id)?.dependencies ?? []) {
        const c = color.get(dep);
        if (c === GRAY) {
          throw new Error(`Circular dependency: ${[...stack, id, dep].join(' → ')}`);
        }
        if (c === WHITE) visit(dep, [...stack, id]);
      }
      color.set(id, BLACK);
    };
    for (const m of manifests) if (color.get(m.id) === WHITE) visit(m.id, []);
  }

  /** Recompute every module's runtime state from license + overrides + deps. */
  async refresh(): Promise<void> {
    const overrides = new Map<string, boolean>(
      (await this.prisma.moduleState.findMany()).map((s) => [s.moduleId, s.enabled]),
    );
    const licensed = new Map<string, boolean>();
    for (const m of this.manifests) {
      licensed.set(m.id, m.tier === 'core' || m.tier === 'community' ? true : await this.license.hasModule(m.id));
    }

    // Desired state before dependency resolution.
    const want = new Map<string, boolean>();
    for (const m of this.manifests) {
      const desired = overrides.has(m.id) ? overrides.get(m.id)! : m.enabledByDefault;
      want.set(m.id, (licensed.get(m.id) ?? false) && desired);
    }

    // Fixpoint: a module can only be enabled if all its deps are enabled.
    const enabled = new Map(want);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of this.manifests) {
        if (!enabled.get(m.id)) continue;
        if (m.dependencies.some((d) => !enabled.get(d))) {
          enabled.set(m.id, false);
          changed = true;
        }
      }
    }

    const statuses = new Map<string, ModuleStatus>();
    for (const m of this.manifests) {
      const isLicensed = licensed.get(m.id) ?? false;
      const isEnabled = enabled.get(m.id) ?? false;
      const unmet = m.dependencies.filter((d) => !enabled.get(d));
      let state: ModuleStateValue;
      let reason: string;
      if (isEnabled) {
        state = 'enabled';
        reason = 'active';
      } else if (want.get(m.id) && unmet.length) {
        state = 'missing_dependency';
        reason = `requires: ${unmet.join(', ')}`;
      } else {
        state = 'disabled';
        reason = 'disabled by an administrator';
      }
      statuses.set(m.id, {
        id: m.id,
        name: m.name,
        description: m.description,
        tier: m.tier,
        state,
        enabled: isEnabled,
        licensed: isLicensed,
        dependencies: m.dependencies,
        unmetDependencies: unmet,
        permissions: m.permissions,
        menu: m.menu ?? [],
        features: m.features ?? [],
        locked: m.tier === 'core',
        reason,
      });
    }
    this.statuses = statuses;
  }

  // --- reads -------------------------------------------------------------
  getStatuses(): ModuleStatus[] {
    return [...this.statuses.values()];
  }
  getStatus(id: string): ModuleStatus | undefined {
    return this.statuses.get(id);
  }
  getEnabled(): ModuleStatus[] {
    return this.getStatuses().filter((s) => s.enabled);
  }
  getManifest(id: string): ModuleManifest {
    const m = this.byId.get(id);
    if (!m) throw new NotFoundException(`Unknown module: ${id}`);
    return m;
  }
  isEnabled(id: string): boolean {
    return this.statuses.get(id)?.enabled ?? false;
  }
  allManifests(): ModuleManifest[] {
    return this.manifests;
  }

  // --- mutations ---------------------------------------------------------
  async enable(id: string, userId?: string): Promise<ModuleStatus> {
    const m = this.getManifest(id);
    const unmet = m.dependencies.filter((d) => !this.isEnabled(d));
    if (unmet.length) {
      throw new BadRequestException(`Enable its dependencies first: ${unmet.join(', ')}`);
    }
    await this.setState(id, true, m.tier);
    await this.event(id, 'module.enabled', `Module "${id}" enabled`, userId);
    await this.refresh();
    return this.getStatus(id)!;
  }

  async disable(id: string, userId?: string): Promise<ModuleStatus> {
    const m = this.getManifest(id);
    if (m.tier === 'core') {
      throw new ForbiddenException('Core modules cannot be disabled');
    }
    const dependents = this.manifests.filter(
      (x) => x.dependencies.includes(id) && this.isEnabled(x.id),
    );
    if (dependents.length) {
      throw new BadRequestException(
        `Disable dependents first: ${dependents.map((d) => d.id).join(', ')}`,
      );
    }
    await this.setState(id, false, m.tier);
    await this.event(id, 'module.disabled', `Module "${id}" disabled`, userId);
    await this.refresh();
    return this.getStatus(id)!;
  }

  private async setState(moduleId: string, enabled: boolean, tier: string): Promise<void> {
    await this.prisma.moduleState.upsert({
      where: { moduleId },
      create: { moduleId, enabled, status: enabled ? 'enabled' : 'disabled', tier },
      update: { enabled, status: enabled ? 'enabled' : 'disabled', tier },
    });
  }

  private async event(moduleId: string, eventType: string, message: string, userId?: string): Promise<void> {
    await this.prisma.moduleEvent
      .create({ data: { moduleId, eventType, message, userId } })
      .catch(() => undefined);
    await this.audit.record({
      userId,
      action: eventType,
      objectType: 'module',
      objectId: moduleId,
      result: 'success',
    });
  }
}
