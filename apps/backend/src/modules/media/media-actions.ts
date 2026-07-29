/**
 * What the Media Manager can do — declared, not drawn.
 *
 * These are the first CAMA contributions, and they replace the hardcoded
 * buttons in the Library Browser's action bar. Each one names its own
 * preconditions; nothing here knows how a toolbar is rendered, and no toolbar
 * knows these exist.
 *
 * Scope note: this is deliberately the set the browser already offered plus the
 * ones its endpoints already support. Declaring an action whose endpoint does
 * not exist would put a button in front of a 404 — the framework makes actions
 * easy to add, which makes that mistake easy too.
 */
import { PERMISSIONS } from '@ultratorrent/shared';
import type { ActionDescriptor } from '@ultratorrent/shared';
import { MAX_BULK_IDS } from './media-bulk.service';

const P = PERMISSIONS;

export const MEDIA_ACTIONS: ActionDescriptor[] = [
  // --- global, library-scoped ------------------------------------------
  {
    id: 'media.library.scan',
    group: 'maintenance',
    entityTypes: [],
    arity: 'none',
    permissions: [P.MEDIA_MANAGER_SCAN],
    module: 'media_manager',
    icon: 'ScanLine',
    async: true,
    order: 10,
  },

  // --- over a selection of items ---------------------------------------
  {
    id: 'media.metadata.refresh',
    group: 'metadata',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_EDIT_METADATA],
    module: 'media_manager',
    icon: 'RefreshCw',
    async: true,
    maxSelection: MAX_BULK_IDS,
    order: 10,
  },
  {
    id: 'media.nfo.generate',
    group: 'metadata',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_GENERATE_NFO],
    module: 'media_manager',
    icon: 'FileCog',
    async: true,
    maxSelection: MAX_BULK_IDS,
    order: 20,
  },
  {
    /*
     * Lock and unlock are separate actions rather than one toggle. A selection
     * can hold both states, and a toggle over a mixed selection has no honest
     * label — "Lock" on twelve items of which four are already locked is a
     * different operation from what it says.
     */
    id: 'media.item.lock',
    group: 'maintenance',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_EDIT_METADATA],
    module: 'media_manager',
    icon: 'Lock',
    maxSelection: MAX_BULK_IDS,
    order: 30,
  },
  {
    id: 'media.item.unlock',
    group: 'maintenance',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_EDIT_METADATA],
    module: 'media_manager',
    icon: 'Unlock',
    maxSelection: MAX_BULK_IDS,
    order: 40,
  },
  {
    /*
     * Move to another library. The files follow the rows — see
     * `MediaBulkService.moveToLibrary` for why a reassignment that left the
     * media under the old root would simply be re-imported on the next scan.
     */
    id: 'media.item.move',
    group: 'media',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_MOVE_FILES],
    module: 'media_manager',
    icon: 'FolderInput',
    maxSelection: MAX_BULK_IDS,
    order: 50,
  },
  {
    /*
     * The two deletes are separate actions, not one action with a checkbox.
     * They differ in permission, in reversibility and in what they mean, and a
     * mis-click between them is the difference between a tidy-up and lost
     * media. `whenUnavailable: 'hide'` on the destructive one so an operator
     * without the grant never sees an erase button at all.
     */
    id: 'media.item.remove',
    group: 'destructive',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_DELETE],
    module: 'media_manager',
    icon: 'ListX',
    maxSelection: MAX_BULK_IDS,
    order: 60,
  },
  {
    id: 'media.item.deleteFiles',
    group: 'destructive',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: [P.MEDIA_MANAGER_DELETE_FILES],
    module: 'media_manager',
    icon: 'Trash2',
    maxSelection: MAX_BULK_IDS,
    whenUnavailable: 'hide',
    order: 70,
  },
];

/*
 * Deliberately NOT declared:
 *
 * - **Rename** (`media.item.rename`). Nothing accepts media item ids for a
 *   rename: `POST media/apply` takes a `RenameRequest` carrying a torrent hash
 *   or a single filesystem path, and `POST media/libraries/:id/organize` takes
 *   a *library*. The action was declared `arity: 'any'` over `media_item` and
 *   survived only because the browser declined to handle it — one handler-map
 *   entry from shipping a button nothing could serve.
 * - **Export** (`media.item.export`). `GET media/items/export.csv` takes view
 *   FILTERS, not an id list, and streams whatever they match. Offered over a
 *   selection it would have exported more rows than were selected — quietly,
 *   which is the worst way to be wrong about a data export.
 *
 * Both return when an endpoint accepts what the surface would send.
 */
