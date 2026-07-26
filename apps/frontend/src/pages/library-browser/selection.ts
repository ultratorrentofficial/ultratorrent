/**
 * Selection over an ordered, virtualized list.
 *
 * Kept as pure functions over a `Set` rather than component state, for two
 * reasons. The range rules (shift-click) are the fiddly part and are far easier
 * to get right — and to test — away from React. And the list is virtualized, so
 * a selection must survive rows unmounting as they scroll out of view; anything
 * derived from rendered DOM would silently forget what is off-screen.
 */

export interface SelectionState {
  ids: ReadonlySet<string>;
  /** Where a shift-range starts. The last row clicked WITHOUT shift. */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: new Set(), anchor: null };

/** Plain click — replaces the selection and moves the anchor. */
export function selectOne(id: string): SelectionState {
  return { ids: new Set([id]), anchor: id };
}

/**
 * Ctrl/Cmd click — toggles one row, leaving the rest alone.
 *
 * The anchor moves to the toggled row even when deselecting, matching every
 * file manager: a subsequent shift-click ranges from the row you last touched,
 * not from the last one that happened to end up selected.
 */
export function toggleOne(state: SelectionState, id: string): SelectionState {
  const ids = new Set(state.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/**
 * Shift click — selects the inclusive range between the anchor and `id`.
 *
 * With no anchor (shift-clicking first) it degrades to a plain selection rather
 * than doing nothing, which is what a user expects and what avoids a dead click.
 * The range is added to the existing selection so ctrl+shift extends rather than
 * replaces; the anchor deliberately does NOT move, so repeated shift-clicks
 * grow and shrink one range from a fixed origin.
 */
export function selectRange(
  state: SelectionState,
  id: string,
  order: readonly string[],
): SelectionState {
  if (!state.anchor) return selectOne(id);

  const from = order.indexOf(state.anchor);
  const to = order.indexOf(id);
  // A row that is no longer in the list (filtered away since the anchor was set)
  // cannot define a range; treat it as a fresh click rather than selecting all.
  if (from === -1 || to === -1) return selectOne(id);

  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const ids = new Set(state.ids);
  for (let i = lo; i <= hi; i += 1) ids.add(order[i]);
  return { ids, anchor: state.anchor };
}

/** Checkbox — toggles without disturbing anything else, including the anchor. */
export function toggleChecked(state: SelectionState, id: string): SelectionState {
  const ids = new Set(state.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: state.anchor ?? id };
}

/**
 * Select-all over the rows currently loaded.
 *
 * Deliberately NOT "every row in the library": paging is incremental, so the
 * client has only what it has fetched. Claiming to select 500 000 items while
 * holding 60 would make every count and every subsequent action a lie. A true
 * whole-library operation is a server-side scope, not a selection.
 */
export function selectAllLoaded(order: readonly string[]): SelectionState {
  return { ids: new Set(order), anchor: order[order.length - 1] ?? null };
}

export function clearSelection(): SelectionState {
  return EMPTY_SELECTION;
}

/**
 * Drop ids that are no longer present.
 *
 * Called when the underlying list changes (a filter, a different library). A
 * selection that outlived its rows would act on things the user can no longer
 * see — the worst possible input to a destructive bulk operation.
 */
export function pruneSelection(
  state: SelectionState,
  order: readonly string[],
): SelectionState {
  const present = new Set(order);
  const ids = new Set([...state.ids].filter((id) => present.has(id)));
  const anchor = state.anchor && present.has(state.anchor) ? state.anchor : null;
  // Identity is preserved only when BOTH are unchanged. Comparing sizes alone
  // kept a stale anchor whenever every selected row survived but the anchor did
  // not — and a stale anchor ranges from a row that is no longer there.
  if (ids.size === state.ids.size && anchor === state.anchor) return state;
  return { ids, anchor };
}

/** Click handler resolution, so every surface interprets modifiers identically. */
export function applyClick(
  state: SelectionState,
  id: string,
  order: readonly string[],
  mods: { shift?: boolean; meta?: boolean },
): SelectionState {
  if (mods.shift) return selectRange(state, id, order);
  if (mods.meta) return toggleOne(state, id);
  return selectOne(id);
}
