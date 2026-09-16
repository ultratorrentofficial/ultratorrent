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

/**
 * Tokens a RECOMMENDATION advertises, derived from its live state.
 *
 * `verifiable` is the interesting one: it is advertised only by a
 * recommendation whose availability can actually be established by a search
 * — so a review-class suggestion never offers a Verify button, and neither
 * does one that has already been verified and is still fresh.
 */
export const RECOMMENDATION_CAPABILITY_TOKENS = ['verifiable'] as const;

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

  /*
   * Recommendations — Phase 4.
   *
   * Exactly ONE action, and it is deliberately not a remediation verb.
   * `verify` asks the indexers whether a better release can actually be
   * obtained; it downloads nothing, replaces nothing and changes no media.
   * The remediation each recommendation points at keeps its OWNING module's
   * action id and permission — `duplicates.ignore`, `media.metadata.refresh`,
   * `subtitles.search`, `torrents.recheck` — because remediation belongs to
   * the module that owns the media, and Media Intelligence routes to it
   * rather than performing it.
   *
   * Gated on `media_manager.scan`, not `view`. A verification is the only
   * operation in this module that reaches outside the installation, and
   * `scan` is the permission that already means "you may make this system do
   * work". Reading the queue stays on `view`.
   */
  {
    entityTypes: ['recommendation'] as EntityType[],
    module: 'media_intelligence',
    group: 'maintenance' as const,
    permissions: [P.MEDIA_MANAGER_SCAN],
    id: 'recommendation.verify',
    // `single`: a verification is one explicit question about one title.
    // Phase 4 deliberately ships no "verify every upgrade in my library" —
    // that is a policy decision, and fanning out across an entire library is
    // exactly the provider stampede this layer exists to avoid.
    arity: 'single',
    requiresEntityCapability: 'verifiable',
    async: true,
    icon: 'Search',
    order: 50,
  },
];
