import 'reflect-metadata';
import { PERMISSIONS, ROLE_PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { MediaDiscoveryController } from './media-discovery.controller';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator';
import { REQUIRED_MANIFESTS, OPTIONAL_MANIFESTS } from '../module-registry/manifests';

/**
 * Who can do what in Media Discovery.
 *
 * The split that matters is between SEEING what was discovered and deciding that
 * the system may acquire on its own. Those are different privileges, and a role
 * that can browse an inbox has not thereby been trusted to turn on automation.
 */

/** The permission metadata a route actually carries at runtime. */
function permissionsFor(method: keyof MediaDiscoveryController): string[] {
  const handler = MediaDiscoveryController.prototype[method] as unknown as object;
  return (Reflect.getMetadata(PERMISSIONS_KEY, handler) as string[] | undefined) ?? [];
}

describe('every route is guarded', () => {
  /*
   * An unguarded route on this controller would expose the catalogue, or worse,
   * let anybody trigger an evaluation that creates watchlist entries and rules.
   */
  it('leaves no handler without a permission', () => {
    const handlers = Object.getOwnPropertyNames(MediaDiscoveryController.prototype).filter(
      (n) => n !== 'constructor' && typeof (MediaDiscoveryController.prototype as never)[n] === 'function',
    );
    const unguarded = handlers.filter((h) => permissionsFor(h as never).length === 0);
    expect(unguarded).toEqual([]);
  });

  it('guards reading with view and never with more', () => {
    for (const route of ['providers', 'inbox', 'item', 'listTemplates', 'listAcquisitionTemplates'] as const) {
      expect(permissionsFor(route)).toEqual([PERMISSIONS.MEDIA_DISCOVERY_VIEW]);
    }
  });

  it('guards template authoring behind templates.manage', () => {
    for (const route of [
      'createTemplate', 'updateTemplate', 'deleteTemplate',
      'createAcquisitionTemplate', 'updateAcquisitionTemplate', 'deleteAcquisitionTemplate',
      'templateOptions', 'runPreview',
    ] as const) {
      expect(permissionsFor(route)).toEqual([PERMISSIONS.MEDIA_DISCOVERY_TEMPLATES_MANAGE]);
    }
  });

  it('guards provider configuration behind providers.manage', () => {
    for (const route of ['enableProvider', 'runSync'] as const) {
      expect(permissionsFor(route)).toEqual([PERMISSIONS.MEDIA_DISCOVERY_PROVIDERS_MANAGE]);
    }
  });

  /*
   * Running an evaluation creates watchlist entries and generates rules. It is
   * emphatically not a read.
   */
  it('guards evaluation behind manage, not view', () => {
    expect(permissionsFor('runEvaluation')).toEqual([PERMISSIONS.MEDIA_DISCOVERY_MANAGE]);
    expect(permissionsFor('runEvaluation')).not.toContain(PERMISSIONS.MEDIA_DISCOVERY_VIEW);
  });

  /*
   * Preview reads the whole catalogue and is part of configuring automation, so
   * it sits with template management rather than with browsing.
   */
  it('guards preview with templates.manage rather than view', () => {
    expect(permissionsFor('runPreview')).toEqual([PERMISSIONS.MEDIA_DISCOVERY_TEMPLATES_MANAGE]);
  });
});

describe('role grants', () => {
  const has = (role: SystemRole, p: string) => ROLE_PERMISSIONS[role].includes(p as never);

  it('lets read-only and ordinary users see the inbox', () => {
    expect(has(SystemRole.READ_ONLY, PERMISSIONS.MEDIA_DISCOVERY_VIEW)).toBe(true);
    expect(has(SystemRole.USER, PERMISSIONS.MEDIA_DISCOVERY_VIEW)).toBe(true);
  });

  /*
   * The whole point of the split. Browsing what was discovered does not imply
   * being trusted to turn on automation that acquires media unasked.
   */
  it('does not let them configure the automation', () => {
    for (const role of [SystemRole.READ_ONLY, SystemRole.USER]) {
      expect(has(role, PERMISSIONS.MEDIA_DISCOVERY_MANAGE)).toBe(false);
      expect(has(role, PERMISSIONS.MEDIA_DISCOVERY_TEMPLATES_MANAGE)).toBe(false);
      expect(has(role, PERMISSIONS.MEDIA_DISCOVERY_PROVIDERS_MANAGE)).toBe(false);
    }
  });

  it('does not let a read-only role act on the inbox', () => {
    expect(has(SystemRole.READ_ONLY, PERMISSIONS.MEDIA_DISCOVERY_MANAGE)).toBe(false);
  });

  it('lets a power user act on the inbox but not reconfigure providers', () => {
    expect(has(SystemRole.POWER_USER, PERMISSIONS.MEDIA_DISCOVERY_VIEW)).toBe(true);
    expect(has(SystemRole.POWER_USER, PERMISSIONS.MEDIA_DISCOVERY_MANAGE)).toBe(true);
    expect(has(SystemRole.POWER_USER, PERMISSIONS.MEDIA_DISCOVERY_PROVIDERS_MANAGE)).toBe(false);
  });

  it('gives administrators everything', () => {
    for (const p of [
      PERMISSIONS.MEDIA_DISCOVERY_VIEW,
      PERMISSIONS.MEDIA_DISCOVERY_MANAGE,
      PERMISSIONS.MEDIA_DISCOVERY_TEMPLATES_MANAGE,
      PERMISSIONS.MEDIA_DISCOVERY_PROVIDERS_MANAGE,
    ]) {
      expect(has(SystemRole.ADMINISTRATOR, p)).toBe(true);
    }
  });
});

describe('the module manifest', () => {
  const manifest = [...REQUIRED_MANIFESTS, ...OPTIONAL_MANIFESTS].find(
    (m) => m.id === 'media_discovery',
  );

  it('exists and is optional', () => {
    expect(manifest).toBeDefined();
    expect(manifest!.required).toBe(false);
  });

  /*
   * Alone among the optional modules. Enabling it is the operator saying the
   * system may acquire media on its own, and a module that arrived switched on
   * would make that an accident rather than a decision.
   */
  it('is OFF by default, unlike every other optional module', () => {
    expect(manifest!.enabledByDefault).toBe(false);
    const othersOn = OPTIONAL_MANIFESTS.filter(
      (m) => m.id !== 'media_discovery' && m.enabledByDefault,
    );
    expect(othersOn.length).toBeGreaterThan(0);
  });

  it('declares exactly the permissions the controller enforces', () => {
    expect([...manifest!.permissions].sort()).toEqual(
      [
        PERMISSIONS.MEDIA_DISCOVERY_VIEW,
        PERMISSIONS.MEDIA_DISCOVERY_MANAGE,
        PERMISSIONS.MEDIA_DISCOVERY_TEMPLATES_MANAGE,
        PERMISSIONS.MEDIA_DISCOVERY_PROVIDERS_MANAGE,
      ].sort(),
    );
  });
});
