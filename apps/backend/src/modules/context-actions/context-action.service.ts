import { Injectable } from '@nestjs/common';
import { SystemRole } from '@ultratorrent/shared';
import type { ActionCatalog, ActionDescriptor, ResolvedAction } from '@ultratorrent/shared';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { CapabilityRegistry } from './capability-registry.service';

/**
 * Resolves the registered actions into the ones a given caller could use.
 *
 * This is the *slow half* of Context-Aware Management Actions: the conditions
 * that are server-authoritative and change rarely — permissions, module state,
 * feature flags, provider availability. What is selected right now is resolved
 * in the browser against this result, because putting a round trip in front of
 * every click is the opposite of what the framework is for.
 *
 * **It is not a security boundary.** Every endpoint keeps its own
 * `@RequirePermissions` guard; this only decides what is worth *offering*.
 * Withholding an action the server would refuse is honesty, not enforcement.
 */
@Injectable()
export class ContextActionService {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly modules: ModuleRegistryService,
  ) {}

  /**
   * The catalogue for one caller.
   *
   * Pure over its inputs and free of I/O — the module registry answers from a
   * map it filled at boot, and provider capabilities are a snapshot — so this
   * stays cheap enough to serve on every page load without a cache in front of
   * it. That matters more than it sounds: a cache keyed on the caller would have
   * to be invalidated when a role changes, and a stale action catalogue is a
   * toolbar that lies.
   */
  catalogFor(user: AuthenticatedUser): ActionCatalog {
    const all = this.registry.list();
    const withheld = { permission: 0, module: 0, feature: 0, provider: 0 };
    const actions: ResolvedAction[] = [];

    for (const action of all) {
      // Order is deliberate: the cheapest and most common reason first, so the
      // diagnostics attribute an action to the *first* thing that ruled it out
      // rather than an arbitrary one.
      if (!this.hasPermissions(user, action)) {
        withheld.permission += 1;
        continue;
      }
      if (action.module && !this.modules.isEnabled(action.module)) {
        withheld.module += 1;
        continue;
      }
      if (action.feature && !this.hasFeature(action.feature)) {
        withheld.feature += 1;
        continue;
      }
      if (
        action.providerCapability &&
        !this.registry.hasProviderCapability(action.providerCapability)
      ) {
        withheld.provider += 1;
        continue;
      }
      actions.push(strip(action));
    }

    return { actions, diagnostics: { total: all.length, withheld } };
  }

  /**
   * Does the caller hold every permission the action requires?
   *
   * Mirrors `PermissionsGuard` exactly, **including the super-admin bypass** —
   * without it an administrator would be shown an empty toolbar for endpoints
   * they can in fact call, which is the most confusing possible failure.
   */
  private hasPermissions(user: AuthenticatedUser, action: ActionDescriptor): boolean {
    if (!action.permissions.length) return true;
    if (user.roles?.includes(SystemRole.SUPER_ADMIN)) return true;
    const held = new Set(user.permissions ?? []);
    return action.permissions.every((p) => held.has(p));
  }

  /**
   * A feature is on when some *enabled* module declares it.
   *
   * `ModuleManifest.features` has been carried through the registry and out of
   * the API since it was introduced, and **read by nothing** — this is its first
   * consumer. Defining it as "an enabled module declares it" rather than adding
   * a parallel flag store keeps one source of truth: a module that is turned off
   * takes its features with it, without anyone maintaining a second list.
   */
  private hasFeature(feature: string): boolean {
    return this.modules.getStatuses().some((s) => s.enabled && s.features.includes(feature));
  }
}

/**
 * Drop what the client neither needs nor should receive.
 *
 * The preconditions are already decided by the time an action is in the list, so
 * `permissions`, `module`, `feature` and `providerCapability` are noise at best.
 * At worst, shipping the permission list to a caller who *failed* it would hand
 * over a map of what they cannot do — but those never reach here, which is
 * precisely why the stripping happens after filtering rather than before.
 */
function strip(a: ActionDescriptor): ResolvedAction {
  return {
    id: a.id,
    group: a.group,
    entityTypes: a.entityTypes,
    arity: a.arity,
    operationsOnly: a.operationsOnly ?? false,
    destructive: a.destructive ?? false,
    requiresEntityCapability: a.requiresEntityCapability,
    whenUnavailable: a.whenUnavailable ?? 'hide',
    maxSelection: a.maxSelection,
    async: a.async ?? false,
    icon: a.icon,
    order: a.order ?? 100,
  };
}
