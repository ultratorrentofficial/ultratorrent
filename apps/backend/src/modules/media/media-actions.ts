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
     * Rename ONE item, not a selection.
     *
     * This was removed once, correctly: `POST media/apply` takes a
     * `RenameRequest` carrying a torrent hash or a single filesystem path, so
     * there is nothing to send for a multi-item selection. A right-click is a
     * single item and an item HAS a path — so at `arity: 'single'` the endpoint
     * fits exactly. The surface previews the plan before applying, because
     * `apply` moves files.
     */
    id: 'media.item.rename',
    group: 'media',
    entityTypes: ['media_item'],
    arity: 'single',
    permissions: [P.MEDIA_MANAGER_RENAME],
    module: 'media_manager',
    icon: 'PenLine',
    order: 45,
  },
  {
    /*
     * Run a cleanup policy against the selected items.
     *
     * Belongs to `library_cleanup`, so it disappears with that module rather
     * than showing a control the install cannot serve. Produces candidates and
     * removes nothing — the Cleanup Center's plan/approve flow still stands
     * between a candidate and a deletion.
     */
    id: 'media.cleanup.runItems',
    group: 'maintenance',
    entityTypes: ['media_item'],
    arity: 'any',
    permissions: [P.LIBRARY_CLEANUP_RUN],
    module: 'library_cleanup',
    icon: 'Recycle',
    async: true,
    maxSelection: MAX_BULK_IDS,
    order: 50,
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
 * - **Rename over a SELECTION.** `media.item.rename` now exists at
 *   `arity: 'single'`, which is the only shape `POST media/apply` can serve: it
 *   takes a hash or a single filesystem path, and
 *   `POST media/libraries/:id/organize` takes a *library*. Declared `'any'` it
 *   would be one handler-map entry from a button nothing could serve, which is
 *   why it was withdrawn entirely until a single-item surface needed it.
 * - **Export** (`media.item.export`). `GET media/items/export.csv` takes view
 *   FILTERS, not an id list, and streams whatever they match. Offered over a
 *   selection it would have exported more rows than were selected — quietly,
 *   which is the worst way to be wrong about a data export.
 *
 * Both return when an endpoint accepts what the surface would send.
 */
