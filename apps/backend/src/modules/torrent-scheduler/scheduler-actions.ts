import { PERMISSIONS } from '@ultratorrent/shared';
import type { ActionDescriptor, EntityType } from '@ultratorrent/shared';

const P = PERMISSIONS;

/**
 * Scheduler instructions, offered where the torrent is.
 *
 * The overrides page asks for a 40-character info-hash, which is honest and
 * unusable — nobody types one. These put the same four instructions on the
 * torrent itself, which is the only place an operator forms the intent: they are
 * looking at the thing they want protected.
 *
 * Deliberately NOT duplicating pause/resume. Those already exist as torrent
 * actions and mean "do this now"; these mean "and keep meaning it", which is a
 * different thing to ask for and belongs in its own group.
 */
const base = {
  entityTypes: ['torrent'] as EntityType[],
  arity: 'any' as const,
  /*
   * Hidden rather than disabled, unlike the torrent lifecycle bar. Those are
   * muscle-memory controls where a disappearing button moves everything under
   * the cursor; these are occasional, and an operator with no scheduler
   * permission should not be shown a menu of things they cannot do.
   */
  whenUnavailable: 'hide' as const,
  /*
   * `maintenance`, not a group of its own. The group union is fixed
   * platform-wide by design — someone who learns where a kind of work lives
   * must find it in the same place everywhere — so widening it for one feature
   * would trade that consistency for a label. These sit beside Recheck, which
   * is the same sort of "manage this torrent's participation" work.
   */
  group: 'maintenance' as const,
};

export const SCHEDULER_ACTIONS: ActionDescriptor[] = [
  {
    ...base,
    id: 'torrent_scheduler.protectFromPause',
    permissions: [P.TORRENT_SCHEDULER_OVERRIDE],
    icon: 'ShieldCheck',
    order: 10,
  },
  {
    ...base,
    id: 'torrent_scheduler.protectFromRemoval',
    permissions: [P.TORRENT_SCHEDULER_OVERRIDE],
    icon: 'ShieldAlert',
    order: 20,
  },
  {
    /*
     * Distinct from protection, and the menu has to make that legible: a
     * protected torrent is still the scheduler's business, an excluded one is
     * not. The label carries the difference because an icon cannot.
     */
    ...base,
    id: 'torrent_scheduler.exclude',
    permissions: [P.TORRENT_SCHEDULER_OVERRIDE],
    icon: 'EyeOff',
    order: 30,
  },
  {
    /*
     * Force start exceeds the operator's own limits, so it reads as a stronger
     * request than the protections above it and sits apart from them.
     */
    ...base,
    id: 'torrent_scheduler.forceStart',
    permissions: [P.TORRENT_SCHEDULER_OVERRIDE],
    icon: 'Zap',
    order: 40,
  },
  {
    ...base,
    id: 'torrent_scheduler.clearOverrides',
    permissions: [P.TORRENT_SCHEDULER_OVERRIDE],
    icon: 'Undo2',
    order: 90,
  },
];
