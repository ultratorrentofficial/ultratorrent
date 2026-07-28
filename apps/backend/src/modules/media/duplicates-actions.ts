/**
 * What can be done to a duplicate group.
 *
 * The Duplicate Center performed **no permission check in the UI at all** — not
 * on detect, not on ignore, not on resolve — while the endpoints behind them
 * require `media_manager.scan`, `media_manager.match` and `media_manager.delete`
 * respectively. Every viewer saw live controls for work most of them could not
 * do, and found out by clicking.
 *
 * The status branch (`group.status === 'open' ? Ignore : Reopen`) becomes an
 * advertised capability, so the two are separate declarations rather than a
 * ternary that has to be written identically everywhere a group appears.
 */
import { PERMISSIONS } from '@ultratorrent/shared';
import type { ActionDescriptor, EntityType } from '@ultratorrent/shared';

const P = PERMISSIONS;

/** Tokens a duplicate group advertises, derived from its status. */
export const DUPLICATE_CAPABILITY_TOKENS = ['ignorable', 'reopenable'] as const;

const base = {
  entityTypes: ['duplicate_group'] as EntityType[],
  module: 'media_manager',
  group: 'maintenance' as const,
};

export const DUPLICATE_ACTIONS: ActionDescriptor[] = [
  {
    ...base,
    id: 'duplicates.detect',
    entityTypes: [],
    arity: 'none',
    permissions: [P.MEDIA_MANAGER_SCAN],
    icon: 'ScanLine',
    async: true,
    order: 20,
  },
  {
    /*
     * "Not duplicates" — the group was a false positive. Requires `match`
     * rather than `delete`: it corrects identity, it does not remove anything.
     */
    ...base,
    id: 'duplicates.ignore',
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_MATCH],
    requiresEntityCapability: 'ignorable',
    icon: 'EyeOff',
    order: 60,
  },
  {
    ...base,
    id: 'duplicates.reopen',
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_MATCH],
    requiresEntityCapability: 'reopenable',
    icon: 'RotateCw',
    order: 61,
  },
];
