/**
 * What can be done to a finding.
 *
 * Disposition only. These actions record what a person DECIDED about a
 * finding; not one of them can change whether the finding is true, and there
 * is deliberately no "fix", "search" or "upgrade" here — remediation belongs
 * to the module that owns the underlying media, with that module's own
 * permission, and Phase 3 routes to it rather than performing it.
 *
 * Gated on `media_manager.view`, the same permission that opens the queue.
 * Triage is a workflow act: it changes no media and no fact, so anyone who
 * can see the list can act on it. Gating triage behind the rebuild permission
 * would hand most operators a queue they are forbidden to clear.
 */
import { PERMISSIONS } from '@ultratorrent/shared';
import type { ActionDescriptor, EntityType } from '@ultratorrent/shared';

const P = PERMISSIONS;

/**
 * Tokens a finding advertises, derived from its live state.
 *
 * A resolved finding advertises none of them: the condition is gone, so
 * there is nothing left to decide. A finding with no disposition cannot be
 * "reset", and one already dismissed need not be dismissed again.
 */
export const FINDING_CAPABILITY_TOKENS = ['dispositionable', 'resettable'] as const;

const base = {
  entityTypes: ['finding'] as EntityType[],
  module: 'media_intelligence',
  group: 'maintenance' as const,
  permissions: [P.MEDIA_MANAGER_VIEW],
};

export const MEDIA_INTELLIGENCE_ACTIONS: ActionDescriptor[] = [
  {
    ...base,
    id: 'attention.finding.acknowledge',
    // `any`: the bulk route takes a set, and a set of one is not a different
    // act — the controller funnels both through one path.
    arity: 'any',
    requiresEntityCapability: 'dispositionable',
    icon: 'Check',
    order: 10,
  },
  {
    ...base,
    id: 'attention.finding.snooze',
    arity: 'any',
    requiresEntityCapability: 'dispositionable',
    icon: 'Clock',
    order: 20,
  },
  {
    ...base,
    id: 'attention.finding.dismiss',
    arity: 'any',
    requiresEntityCapability: 'dispositionable',
    icon: 'EyeOff',
    /*
     * NOT `destructive`. Dismissal hides a finding from the active queue and
     * changes nothing about the media — marking it destructive would put a
     * red confirmation in front of an act that deletes nothing and is undone
     * by a single click of Reset.
     */
    order: 30,
  },
  {
    ...base,
    id: 'attention.finding.reset',
    arity: 'any',
    requiresEntityCapability: 'resettable',
    icon: 'RotateCw',
    order: 40,
  },
];
