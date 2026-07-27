/**
 * The client half of Context-Aware Management Actions.
 *
 * The server resolved the slow, security-relevant conditions once — permissions,
 * module state, feature flags, provider availability — into a catalogue. This
 * resolves the fast ones on every selection change: what is selected, how many,
 * of what type, and whether Operations Mode is on.
 *
 * Splitting it that way is the whole point. Asking the server per click would
 * put a round trip in front of every selection; asking the client to evaluate
 * permissions would mean shipping the permission model to the browser and
 * trusting it.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { resolveActions, type ActionContext, type ActionGroup, type ActionVerdict } from '@ultratorrent/shared';
import { api } from '@/lib/api';

/**
 * The catalogue changes only when a role, module or provider changes — none of
 * which happen while someone is clicking around a library. A long stale time
 * keeps this off the wire without making it stale in any way a user would
 * notice; a session that outlives a permission change gets it on the next load.
 */
const STALE_MS = 5 * 60_000;

export const CONTEXT_ACTIONS_QUERY_KEY = ['context-actions', 'catalog'] as const;

export interface ContextActionsResult {
  groups: Array<{ group: ActionGroup; actions: ActionVerdict[] }>;
  /** True until the catalogue has arrived. Surfaces render nothing meanwhile. */
  isLoading: boolean;
  /** The catalogue could not be fetched — surfaces should say so, not go blank. */
  isError: boolean;
}

/**
 * Resolve the actions for a context.
 *
 * **Fails closed.** Until the catalogue arrives there are no actions, so nothing
 * renders. This is the opposite of `ModuleContext`, which deliberately fails
 * *open* while loading to stop the sidebar flickering — the right trade there,
 * because a nav item that appears late is noise, while an action button that
 * appears before we know it is permitted is an offer we may have to withdraw.
 */
export function useContextActions(ctx: ActionContext): ContextActionsResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: CONTEXT_ACTIONS_QUERY_KEY,
    queryFn: () => api.contextActions.catalog(),
    staleTime: STALE_MS,
  });

  const actions = data?.actions;
  const { selection, operationsMode } = ctx;

  const groups = useMemo(
    () => (actions ? resolveActions(actions, { selection, operationsMode }) : []),
    // `selection` is rebuilt by the caller on every selection change, which is
    // exactly when this must recompute.
    [actions, selection, operationsMode],
  );

  return { groups, isLoading, isError };
}
