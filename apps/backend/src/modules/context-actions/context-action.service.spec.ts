import { SystemRole } from '@ultratorrent/shared';
import type { ActionDescriptor } from '@ultratorrent/shared';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CapabilityRegistry, DuplicateActionError } from './capability-registry.service';
import { ContextActionService } from './context-action.service';

/** A module registry stand-in: enabled ids, and the features they declare. */
function modules(enabled: Record<string, string[]> = {}) {
  return {
    isEnabled: (id: string) => id in enabled,
    getStatuses: () =>
      Object.entries(enabled).map(([id, features]) => ({ id, enabled: true, features })),
  } as any;
}

function user(over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', username: 'u', roles: ['user'], permissions: [], ...over };
}

function descriptor(over: Partial<ActionDescriptor> = {}): ActionDescriptor {
  return {
    id: 'media.metadata.refresh',
    group: 'metadata',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: ['media_manager.edit_metadata'],
    ...over,
  };
}

function build(actions: ActionDescriptor[], enabled: Record<string, string[]> = {}) {
  const registry = new CapabilityRegistry();
  registry.registerAll(actions);
  return { registry, service: new ContextActionService(registry, modules(enabled)) };
}

describe('CapabilityRegistry', () => {
  it('rejects a duplicate id rather than silently replacing the first', () => {
    const registry = new CapabilityRegistry();
    registry.register(descriptor());
    // Two modules claiming one id is a wiring bug; last-write-wins would make
    // which module won depend on module load order.
    expect(() => registry.register(descriptor())).toThrow(DuplicateActionError);
  });

  it('refuses an id that is not dot-namespaced', () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.register(descriptor({ id: 'refresh' }))).toThrow(/dot-namespaced/);
  });

  it('refuses an entity action that names no entity type', () => {
    // It would otherwise apply to every selection of every kind — the opposite
    // of context-aware.
    const registry = new CapabilityRegistry();
    expect(() => registry.register(descriptor({ entityTypes: [] }))).toThrow(/entityTypes/);
  });

  it('allows a global action to name no entity type', () => {
    const registry = new CapabilityRegistry();
    expect(() =>
      registry.register(descriptor({ id: 'media.library.scan', arity: 'none', entityTypes: [] })),
    ).not.toThrow();
  });

  it('tracks provider capability as an idempotent snapshot', () => {
    const registry = new CapabilityRegistry();
    expect(registry.hasProviderCapability('subtitle.download')).toBe(false);
    registry.setProviderCapability('subtitle.download', true);
    registry.setProviderCapability('subtitle.download', true);
    expect(registry.providerCapabilityKeys()).toEqual(['subtitle.download']);
    registry.setProviderCapability('subtitle.download', false);
    expect(registry.hasProviderCapability('subtitle.download')).toBe(false);
  });
});

describe('ContextActionService — permissions', () => {
  it('withholds an action the caller lacks a permission for', () => {
    const { service } = build([descriptor()]);
    const catalog = service.catalogFor(user());
    expect(catalog.actions).toEqual([]);
    expect(catalog.diagnostics.withheld.permission).toBe(1);
  });

  it('offers it once the permission is held', () => {
    const { service } = build([descriptor()]);
    const catalog = service.catalogFor(user({ permissions: ['media_manager.edit_metadata'] }));
    expect(catalog.actions.map((a) => a.id)).toEqual(['media.metadata.refresh']);
  });

  it('requires EVERY listed permission, not any of them', () => {
    const { service } = build([
      descriptor({ permissions: ['media_manager.edit_metadata', 'media_manager.delete'] }),
    ]);
    expect(service.catalogFor(user({ permissions: ['media_manager.edit_metadata'] })).actions)
      .toEqual([]);
  });

  it('gives a super admin everything, mirroring PermissionsGuard', () => {
    // Without the bypass an administrator would be shown an empty toolbar for
    // endpoints they can in fact call — the most confusing possible failure.
    const { service } = build([descriptor()]);
    const admin = user({ roles: [SystemRole.SUPER_ADMIN], permissions: [] });
    expect(service.catalogFor(admin).actions).toHaveLength(1);
  });

  it('offers an action that requires no permission at all', () => {
    const { service } = build([descriptor({ permissions: [] })]);
    expect(service.catalogFor(user()).actions).toHaveLength(1);
  });
});

describe('ContextActionService — module, feature and provider gating', () => {
  const perms = ['media_manager.edit_metadata'];

  it('withholds an action whose module is disabled', () => {
    const { service } = build([descriptor({ module: 'media_manager' })]);
    const catalog = service.catalogFor(user({ permissions: perms }));
    expect(catalog.actions).toEqual([]);
    expect(catalog.diagnostics.withheld.module).toBe(1);
  });

  it('offers it when the module is enabled', () => {
    const { service } = build([descriptor({ module: 'media_manager' })], { media_manager: [] });
    expect(service.catalogFor(user({ permissions: perms })).actions).toHaveLength(1);
  });

  it('treats a feature as on only when an ENABLED module declares it', () => {
    const withFeature = [descriptor({ feature: 'universal_scraper' })];
    const off = build(withFeature, { media_manager: [] });
    expect(off.service.catalogFor(user({ permissions: perms })).actions).toEqual([]);
    expect(off.service.catalogFor(user({ permissions: perms })).diagnostics.withheld.feature).toBe(1);

    const on = build(withFeature, { media_manager: ['universal_scraper'] });
    expect(on.service.catalogFor(user({ permissions: perms })).actions).toHaveLength(1);
  });

  it('withholds an action whose provider capability is unavailable, and restores it', () => {
    const { registry, service } = build([descriptor({ providerCapability: 'subtitle.download' })]);
    expect(service.catalogFor(user({ permissions: perms })).actions).toEqual([]);
    expect(service.catalogFor(user({ permissions: perms })).diagnostics.withheld.provider).toBe(1);

    // A provider coming back online must restore the action with no redeploy —
    // this is what "actions disappear automatically" has to mean in both
    // directions.
    registry.setProviderCapability('subtitle.download', true);
    expect(service.catalogFor(user({ permissions: perms })).actions).toHaveLength(1);
  });
});

describe('ContextActionService — the shape sent to the client', () => {
  const perms = ['media_manager.edit_metadata'];

  it('strips the preconditions the server already decided', () => {
    // Every precondition satisfied, so the action survives and we can inspect
    // exactly what crosses the wire.
    const { registry, service } = build(
      [descriptor({ module: 'media_manager', feature: 'f', providerCapability: 'p' })],
      { media_manager: ['f'] },
    );
    registry.setProviderCapability('p', true);

    const [action] = service.catalogFor(user({ permissions: perms })).actions;
    expect(action.id).toBe('media.metadata.refresh');

    // Shipping the permission list to a caller is noise at best; to one who
    // failed it, a map of what they cannot do.
    expect(action).not.toHaveProperty('permissions');
    expect(action).not.toHaveProperty('module');
    expect(action).not.toHaveProperty('feature');
    expect(action).not.toHaveProperty('providerCapability');
  });

  it('defaults the optional fields rather than leaving them undefined', () => {
    const { service } = build([descriptor()]);
    const [action] = service.catalogFor(user({ permissions: perms })).actions;
    expect(action.operationsOnly).toBe(false);
    expect(action.destructive).toBe(false);
    expect(action.whenUnavailable).toBe('hide');
    expect(action.async).toBe(false);
    expect(action.order).toBe(100);
  });

  it('reports why actions were withheld, attributing each to one reason', () => {
    const { service } = build(
      [
        descriptor({ id: 'a.one' }),
        descriptor({ id: 'a.two', permissions: [], module: 'absent' }),
        descriptor({ id: 'a.three', permissions: [], feature: 'absent' }),
        descriptor({ id: 'a.four', permissions: [], providerCapability: 'absent' }),
      ],
      {},
    );
    const { diagnostics } = service.catalogFor(user());
    expect(diagnostics.total).toBe(4);
    expect(diagnostics.withheld).toEqual({ permission: 1, module: 1, feature: 1, provider: 1 });
  });
});
