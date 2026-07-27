import { Injectable, Logger } from '@nestjs/common';
import type { ActionDescriptor } from '@ultratorrent/shared';

/** Registering the same action id twice is a wiring bug, not a merge. */
export class DuplicateActionError extends Error {
  constructor(id: string) {
    super(`Action already registered: ${id}`);
    this.name = 'DuplicateActionError';
  }
}

/**
 * Where modules declare what can be done, and to what.
 *
 * Deliberately shaped like `JobRegistry`: an in-memory map filled from each
 * owning module's `onModuleInit`, global so anything can contribute, and loud
 * about duplicates. The platform already proved that pattern for job types, and
 * an action catalogue has the same lifecycle — fixed at boot, read constantly.
 *
 * The registry holds **declarations only**. It performs no filtering, knows
 * nothing about the caller, and never decides whether an action may run;
 * `ContextActionService` resolves, and the endpoint's own guard authorises.
 * Keeping those apart is what lets a module contribute an action without
 * learning how permissions, modules or providers are evaluated.
 */
@Injectable()
export class CapabilityRegistry {
  private readonly logger = new Logger(CapabilityRegistry.name);
  private readonly actions = new Map<string, ActionDescriptor>();

  /**
   * Provider capabilities currently available, by key (`subtitle.download`).
   *
   * A **snapshot**, not a probe. Resolution runs on every catalogue fetch and
   * must not perform I/O: asking six providers whether they are reachable, in
   * line, would make the toolbar wait on the slowest one. Modules push their
   * state here when it changes — after a health check, on config save — and
   * resolution reads it in O(1).
   */
  private readonly providerCapabilities = new Set<string>();

  /**
   * Declare an action.
   *
   * Called from the owning module's `onModuleInit`, so the catalogue is complete
   * before the first request and a missing registration fails at boot rather
   * than showing up as a quietly absent button.
   */
  register(action: ActionDescriptor): void {
    if (this.actions.has(action.id)) throw new DuplicateActionError(action.id);

    if (!action.id.includes('.')) {
      throw new Error(`Action id must be dot-namespaced: ${action.id}`);
    }
    if (action.arity !== 'none' && action.entityTypes.length === 0) {
      // An action over entities that names no entity type would apply to every
      // selection, which is the opposite of context-aware.
      throw new Error(`Action ${action.id} must declare entityTypes for arity "${action.arity}"`);
    }

    this.actions.set(action.id, action);
  }

  /** Declare many at once; the whole batch is one module's contribution. */
  registerAll(actions: readonly ActionDescriptor[]): void {
    for (const a of actions) this.register(a);
    this.logger.log(`Registered ${actions.length} actions (${this.actions.size} total)`);
  }

  list(): ActionDescriptor[] {
    return [...this.actions.values()];
  }

  get(id: string): ActionDescriptor | undefined {
    return this.actions.get(id);
  }

  /**
   * Report whether a provider capability is currently available.
   *
   * Idempotent, so a health check can call it on every tick without churn.
   */
  setProviderCapability(key: string, available: boolean): void {
    if (available) this.providerCapabilities.add(key);
    else this.providerCapabilities.delete(key);
  }

  hasProviderCapability(key: string): boolean {
    return this.providerCapabilities.has(key);
  }

  providerCapabilityKeys(): string[] {
    return [...this.providerCapabilities];
  }
}
