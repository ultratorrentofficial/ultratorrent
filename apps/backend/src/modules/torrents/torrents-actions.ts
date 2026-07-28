/**
 * What can be done to a torrent.
 *
 * Unlike Jobs, the torrent bars already gated on permission — this migration is
 * a consolidation rather than a repair. What it fixes is that the two bars
 * (`TorrentActionsBar` for one torrent, `BulkToolbar` for many) are near-
 * duplicate implementations of the same list, and that **neither considered
 * state at all**: Resume was live on a downloading torrent, Pause on a stopped
 * one. Every such click was a request the engine would reject.
 *
 * State now travels with the entity, so both bars resolve from one declaration.
 */
import { PERMISSIONS } from '@ultratorrent/shared';
import type { ActionDescriptor, EntityType } from '@ultratorrent/shared';

const P = PERMISSIONS;

/**
 * Capability tokens a torrent row advertises, derived from its state on the
 * client. Named for the action so they encode "possible right now" rather than
 * "supported in principle".
 */
export const TORRENT_CAPABILITY_TOKENS = [
  'resume',
  'pause',
  'start',
  'stop',
  'recheck',
] as const;

const base = {
  entityTypes: ['torrent'] as EntityType[],
  arity: 'any' as const,
  /*
   * Disabled rather than hidden, matching what the torrent bars already do.
   * This is a control surface people use constantly and by muscle memory; a
   * Pause that disappears when a torrent stops would move every other button
   * under the cursor mid-task.
   */
  whenUnavailable: 'disable' as const,
};

export const TORRENT_ACTIONS: ActionDescriptor[] = [
  {
    ...base,
    id: 'torrents.resume',
    group: 'media',
    permissions: [P.TORRENTS_RESUME],
    requiresEntityCapability: 'resume',
    icon: 'Play',
    order: 10,
  },
  {
    ...base,
    id: 'torrents.pause',
    group: 'media',
    permissions: [P.TORRENTS_PAUSE],
    requiresEntityCapability: 'pause',
    icon: 'Pause',
    order: 20,
  },
  {
    ...base,
    id: 'torrents.stop',
    group: 'media',
    permissions: [P.TORRENTS_STOP],
    requiresEntityCapability: 'stop',
    icon: 'Square',
    order: 30,
  },
  {
    ...base,
    id: 'torrents.recheck',
    group: 'maintenance',
    permissions: [P.TORRENTS_RECHECK],
    requiresEntityCapability: 'recheck',
    icon: 'RefreshCw',
    order: 10,
  },
  {
    /*
     * Removing the torrent and removing its data are separate actions because
     * they are separate permissions, and deliberately so: `torrents.delete`
     * lets someone tidy a list, `torrents.delete_data` destroys files. Folding
     * them into one action with a checkbox would mean the weaker permission
     * rendered a control that could do the stronger thing.
     *
     * Neither requires a capability token: a torrent in any state can be
     * removed, which is the point of removing it.
     *
     * `removeData` requires ONLY `torrents.delete_data`, matching
     * `DELETE :hash/data` and the bulk map. Also demanding `torrents.delete`
     * read as defence in depth but simply withheld the action from anyone
     * granted the stronger permission without the weaker one.
     */
    ...base,
    id: 'torrents.remove',
    group: 'maintenance',
    permissions: [P.TORRENTS_DELETE],
    destructive: true,
    icon: 'Trash2',
    order: 90,
  },
  {
    ...base,
    id: 'torrents.removeData',
    group: 'maintenance',
    permissions: [P.TORRENTS_DELETE_DATA],
    destructive: true,
    operationsOnly: true,
    icon: 'Trash2',
    order: 91,
  },
];
