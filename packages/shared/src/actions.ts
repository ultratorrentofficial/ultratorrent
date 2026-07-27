/**
 * Context-Aware Management Actions (CAMA) — the shared contract.
 *
 * The platform's answer to "what can I do with what is currently selected?".
 * Instead of each screen hardcoding a toolbar, every module *declares* the
 * actions it offers and the conditions under which they apply; every action
 * surface is then a projection of that one registry — the same relationship the
 * sidebar, breadcrumbs, command palette and mobile switcher already have to
 * `NAV_GROUPS`.
 *
 * This file is the vocabulary both sides compile against. It deliberately holds
 * no logic: the backend owns the registry and the security-relevant resolution,
 * the frontend owns selection-shaped resolution, and neither should be able to
 * drift from the other's idea of what an action *is*.
 *
 * ## Where resolution happens, and why it is split
 *
 * Two kinds of fact decide whether an action is offered, and they change at
 * completely different rates:
 *
 * - **Slow, server-authoritative** — the caller's permissions, which modules are
 *   enabled, whether a provider is reachable, feature flags. These are security
 *   relevant, live only on the server, and change rarely. The server resolves
 *   them once into a per-user *envelope*.
 * - **Fast, client-local** — what is selected right now, how many, of what type,
 *   in which workspace, under which filter. These change on every click.
 *
 * Resolving the fast facts on the server would put a round trip in front of
 * every selection change, which is the opposite of the "effortless" the
 * framework exists to deliver. Resolving the slow facts on the client would mean
 * shipping the permission model to the browser and trusting it. So the envelope
 * is fetched once and re-filtered locally as the selection moves.
 *
 * **None of this is a security boundary.** An action absent from the envelope is
 * absent because offering a button the server will refuse is a lie, not because
 * hiding it protects anything. Every endpoint keeps its own `@RequirePermissions`
 * guard, and CAMA never becomes the thing that decides whether a call succeeds.
 */

/**
 * The kinds of thing a user can select and act on.
 *
 * **Not every entity here has a database row of its own**, and the distinction
 * matters when writing a handler:
 *
 * - `media_item` is the one true selectable media entity — a row in
 *   `media_items` with a stable id. **Movies and episodes are both this.**
 * - `tv_show` and `season` are **projections**: the Library Browser groups flat
 *   `MediaItem` rows at query time, so a show has no id of its own and is
 *   addressed by a series key. An action targeting one resolves to the item ids
 *   underneath it. (Decision recorded in ARCHITECTURE.md, 2026-07-26.)
 *
 *   Two further traps here. A `MediaShow` row *does* exist, but it is keyed to a
 *   show **folder** and used only by the acquisition watchlist — it is not the
 *   browser's show and the two must not be conflated. And the series key is
 *   derived from the **path** (`dir:<normalized>` / `title:<lower>`), so it
 *   changes when a folder is renamed or moved: it may be carried through a
 *   request, never stored as though it were durable.
 * - `torrent` is a `TorrentSnapshot`, reconciled from the engine. Its durable
 *   identity is `(engineId, hash)` rather than the surrogate row id.
 * - `media_version` is **not implemented** — there is no `MediaVersion` model,
 *   and nothing represents "the same title in two qualities" as a row. It is
 *   declared so version actions have somewhere to land, and any descriptor using
 *   it must stay unregistered until the model exists.
 * - `playlist`, `artist`, `album`, `track` and `photo` are **not representable**
 *   today: `MediaItem.mediaType` admits only video types, so music and photo
 *   libraries scan as `other_video` and there is nothing to project from, and no
 *   playlist model exists at all.
 *
 * Everything else below is a real row with a stable id.
 *
 * Declaring an entity type is cheap; registering an action against one that
 * cannot be identified is how a menu ends up offering work the platform cannot
 * do. Prefer leaving it out.
 */
export type EntityType =
  // Media — the parts that exist today
  | 'library'
  | 'media_item'
  | 'tv_show'
  | 'season'
  // Acquisition
  | 'torrent'
  | 'rss_feed'
  | 'rss_rule'
  | 'indexer'
  // Maintenance surfaces
  | 'cleanup_candidate'
  | 'duplicate_group'
  | 'subtitle'
  | 'artwork'
  | 'file'
  | 'trash_item'
  | 'collection'
  // Platform
  | 'job'
  | 'notification'
  | 'user'
  | 'automation_rule'
  // Declared, not yet representable — see the note above
  | 'media_version'
  | 'playlist';

/**
 * The logical groups an action belongs to.
 *
 * Fixed and platform-wide on purpose: a user who learns that artwork work lives
 * under "Artwork" in the Library Browser must find it in the same place in the
 * Duplicate Center. Groups are presentation, never permission.
 */
export type ActionGroup =
  | 'media'
  | 'playback'
  | 'metadata'
  | 'artwork'
  | 'subtitles'
  | 'versions'
  | 'collections'
  | 'analytics'
  | 'maintenance'
  | 'export'
  | 'administration';

/** Display order for groups, so every surface presents them identically. */
export const ACTION_GROUP_ORDER: readonly ActionGroup[] = [
  'media',
  'playback',
  'metadata',
  'artwork',
  'subtitles',
  'versions',
  'collections',
  'analytics',
  'maintenance',
  'export',
  'administration',
] as const;

/**
 * How many things an action needs.
 *
 * `none` is not "works with nothing selected" — it is *global* work that belongs
 * to the surface rather than to a selection (scan this library, import, open
 * settings). An action is offered when the current selection matches its arity,
 * which is what makes an empty selection show a short, calm toolbar instead of a
 * long disabled one.
 */
export type SelectionArity = 'none' | 'single' | 'multi' | 'any';

/**
 * A pointer to one selected thing.
 *
 * `id` is a row id for real entities and a synthetic key for projections (a
 * series key for `tv_show`, `seriesKey:seasonNumber` for `season`). Handlers
 * must not assume it addresses a table.
 */
export interface EntityRef {
  type: EntityType;
  id: string;
  /**
   * What this particular entity currently supports — its *advertised
   * capabilities*, and the reason the framework can express state-dependent
   * actions at all.
   *
   * Type and permission decide what is possible in general; these decide what is
   * possible **right now, for this row**. A running job advertises
   * `cancellable`; a finished one does not. A locked media item does not
   * advertise `editable`. A draft cleanup policy advertises `publishable`.
   *
   * The platform already resolves actions this way in three places, each
   * privately: `rowActions(job)` derives buttons from job status, the cleanup
   * policy row branches on status, and the workflow editor branches on
   * published/archived. Making it a field is what lets those become
   * declarations instead of three hand-written functions that gate on status and
   * forget to gate on permission.
   *
   * Omitted means "no capability constraints apply" — an entity that advertises
   * nothing does not thereby lose every action, or the common case would need
   * boilerplate on every row.
   */
  capabilities?: string[];
}

/**
 * What to do when an action applies but cannot run right now.
 *
 * Both answers are correct in different places, which is why this is a
 * declaration rather than a convention:
 *
 * - `hide` — the default. An action that is irrelevant is clutter.
 * - `disable` — when the user has reason to expect the action and its absence
 *   would read as a bug. The Media Manager does this deliberately for a locked
 *   item: the disabled button "has to be what tells them why it won't run".
 *   Vanishing would leave them hunting for a feature that is still there.
 */
export type UnavailableBehaviour = 'hide' | 'disable';

/** Why an applicable action cannot currently run. */
export type UnavailableReason = 'entity_capability' | 'max_selection';

/**
 * What a module declares about one action.
 *
 * Every field is a *precondition*: the action is offered only when all of them
 * hold. Adding a condition here is how a module narrows its own action without
 * any UI change, which is the extensibility property the framework is for.
 */
export interface ActionDescriptor {
  /**
   * Stable, dot-namespaced and globally unique — `media.metadata.refresh`.
   * It is the i18n key stem, the analytics key and the audit verb, so renaming
   * one is a breaking change rather than a cosmetic edit.
   */
  id: string;
  group: ActionGroup;
  /**
   * Which entity types this applies to. An action valid for several lists them
   * all; a **mixed** selection offers only actions valid for *every* type
   * present, because a toolbar that acts on some of the selection silently is
   * the worst outcome the framework can produce.
   */
  entityTypes: EntityType[];
  arity: SelectionArity;
  /** Every one of these is required — the check is AND, never OR. */
  permissions: string[];
  /** Module id that must be enabled for this action to exist at all. */
  module?: string;
  /** Feature flag, checked against the module registry's `features`. */
  feature?: string;
  /**
   * A provider capability that must currently be available — for example
   * `subtitle.download`. This is what makes subtitle actions vanish when every
   * provider is offline rather than fail on click.
   */
  providerCapability?: string;
  /**
   * Hidden in Browse Mode, revealed in Operations Mode.
   *
   * Progressive disclosure, **not** removal: the platform's first UX principle
   * is that nothing is dropped to make room. An operations-only action is still
   * reachable, still permitted and still in the command palette — it simply is
   * not in the way of someone who came to look at a show.
   */
  operationsOnly?: boolean;
  /**
   * Deletes or overwrites something. Surfaces must style these apart and
   * confirm them; the flag exists so no surface has to keep its own list.
   */
  destructive?: boolean;
  /**
   * A capability **every** selected entity must advertise — `cancellable`,
   * `editable`, `publishable`. This is how a status-dependent action stays a
   * declaration instead of a hand-written branch per surface.
   */
  requiresEntityCapability?: string;
  /** What to do when the action applies but cannot run. Defaults to `hide`. */
  whenUnavailable?: UnavailableBehaviour;
  /**
   * Refuse a selection larger than this. Mirrors the server's own bulk ceiling
   * so the UI declines before the request rather than after the 400.
   */
  maxSelection?: number;
  /** Runs as a background job, so the surface expects a job id back. */
  async?: boolean;
  /** Lucide icon name, resolved by the client. */
  icon?: string;
  /**
   * Ordering within a group; lower is earlier, ties break on id so the toolbar
   * is stable between renders rather than dependent on registration order.
   */
  order?: number;
}

/**
 * An action that survived server-side resolution, as sent to the client.
 *
 * The preconditions the server already decided are **stripped** rather than
 * carried: sending `permissions` to a client that has them all is noise, and
 * sending them to one that does not would be handing over a list of what it
 * cannot do. What remains is what the client still needs to resolve locally.
 */
export interface ResolvedAction {
  id: string;
  group: ActionGroup;
  entityTypes: EntityType[];
  arity: SelectionArity;
  operationsOnly: boolean;
  destructive: boolean;
  requiresEntityCapability?: string;
  whenUnavailable: UnavailableBehaviour;
  maxSelection?: number;
  async: boolean;
  icon?: string;
  order: number;
}

/** An action placed in a surface, with whether it can actually run. */
export interface ActionVerdict {
  action: ResolvedAction;
  enabled: boolean;
  /** Present only when `enabled` is false — what to explain to the user. */
  reason?: UnavailableReason;
}

/** The per-user envelope: everything the client needs to resolve locally. */
export interface ActionCatalog {
  actions: ResolvedAction[];
  /**
   * Why the catalog is what it is. Not consumed by the UI — it exists so an
   * operator asking "why can't I see Download Subtitles?" gets an answer from
   * the API instead of from a maintainer reading resolution code.
   */
  diagnostics: {
    /** Registered before filtering. */
    total: number;
    /** Dropped, by reason. */
    withheld: { permission: number; module: number; feature: number; provider: number };
  };
}

/** The live, client-side context an action is resolved against. */
export interface ActionContext {
  selection: EntityRef[];
  /** Operations Mode reveals `operationsOnly` actions. */
  operationsMode?: boolean;
}

/**
 * The entity types present in a selection, deduplicated.
 *
 * Exported because both sides need the same answer: the client to resolve the
 * toolbar, the server to validate that a dispatched action actually accepts what
 * it was handed.
 */
export function selectionTypes(selection: readonly EntityRef[]): EntityType[] {
  return [...new Set(selection.map((e) => e.type))];
}

/** Which arity a selection of this size satisfies. */
export function arityOf(count: number): SelectionArity {
  if (count === 0) return 'none';
  return count === 1 ? 'single' : 'multi';
}

/**
 * Does an action apply to this context?
 *
 * The single definition of applicability, used by the client to build the
 * toolbar **and** by the server to validate a dispatch. Two implementations of
 * this rule would eventually disagree, and the disagreement would show up as an
 * action that renders and then 400s.
 */
export function appliesTo(action: ResolvedAction, ctx: ActionContext): boolean {
  const count = ctx.selection.length;

  if (action.operationsOnly && !ctx.operationsMode) return false;

  // Arity. `any` still excludes an empty selection: an action over entities
  // needs entities, and only an explicitly global action runs without them.
  const arity = arityOf(count);
  if (action.arity === 'none') return count === 0;
  if (count === 0) return false;
  if (action.arity !== 'any' && action.arity !== arity) return false;

  // Every type present must be supported — see `entityTypes`. An empty
  // selection has no types to check and has already been handled above.
  return selectionTypes(ctx.selection).every((t) => action.entityTypes.includes(t));
}

/**
 * Can an applicable action actually run right now?
 *
 * Kept apart from `appliesTo` because the two failures are not the same thing.
 * An action that does not *apply* is irrelevant here and showing it greyed out
 * is noise; an action that applies but is *blocked* is something the user
 * expected, and its silent absence reads as a missing feature. Only the second
 * kind is worth a disabled control and an explanation.
 */
export function availabilityOf(
  action: ResolvedAction,
  ctx: ActionContext,
): { enabled: boolean; reason?: UnavailableReason } {
  if (action.maxSelection != null && ctx.selection.length > action.maxSelection) {
    return { enabled: false, reason: 'max_selection' };
  }

  const required = action.requiresEntityCapability;
  if (required) {
    // EVERY selected entity must advertise it. Running on the subset that
    // qualifies would act on less than the selection without saying so.
    const all = ctx.selection.every((e) => e.capabilities?.includes(required));
    if (!all) return { enabled: false, reason: 'entity_capability' };
  }

  return { enabled: true };
}

/**
 * Resolve a context into the actions to present, grouped and ordered.
 *
 * Returns groups in `ACTION_GROUP_ORDER`, omitting empty ones — an empty group
 * heading advertises a category with nothing in it. Actions that are blocked are
 * included as disabled verdicts only when they asked to be; the rest are
 * dropped, so the common surface stays short.
 */
export function resolveActions(
  actions: readonly ResolvedAction[],
  ctx: ActionContext,
): Array<{ group: ActionGroup; actions: ActionVerdict[] }> {
  const verdicts: ActionVerdict[] = [];

  for (const action of actions) {
    if (!appliesTo(action, ctx)) continue;
    const { enabled, reason } = availabilityOf(action, ctx);
    if (!enabled && action.whenUnavailable === 'hide') continue;
    verdicts.push({ action, enabled, reason });
  }

  return ACTION_GROUP_ORDER.map((group) => ({
    group,
    actions: verdicts
      .filter((v) => v.action.group === group)
      .sort((a, b) => a.action.order - b.action.order || a.action.id.localeCompare(b.action.id)),
  })).filter((g) => g.actions.length > 0);
}
