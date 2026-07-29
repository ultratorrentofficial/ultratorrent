/**
 * Every declared action must match the endpoint it will call.
 *
 * This gate exists because a declaration is one object literal and a wrong one
 * is invisible to every other check: `tsc` sees a valid `ActionDescriptor`, the
 * unit tests see a registry that accepted it, and the boot gate sees it
 * register. The failure only appears when a user clicks a button and gets a 403
 * or a 404.
 *
 * Two real defects motivated it, both shipped before being caught by hand:
 *
 * - `subtitles.download` was declared on `media_item`, but the endpoint is
 *   `POST candidates/:candidateId/download` and takes a subtitle candidate.
 * - The jobs bulk routes require `jobs.bulk_manage` **in addition to** the verb
 *   permission, while the declarations listed only the verb — so a user holding
 *   `jobs.cancel` alone would see Cancel on a multi-selection and get a 403.
 *
 * The mapping lives here rather than on the descriptor so production code gains
 * no coupling to controllers, and route metadata is read through `Reflect`
 * rather than by booting Nest, which keeps this a fast unit test.
 */
import 'reflect-metadata';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator';
import { MediaController } from '../media/media.controller';
import { PlatformJobsController } from '../jobs/platform-jobs.controller';
import { TorrentsController } from '../torrents/torrents.controller';
import { FilesController } from '../files/files.controller';
import { SubtitleIntelligenceController } from '../subtitle-intelligence/subtitle-intelligence.controller';
import { MEDIA_ACTIONS } from '../media/media-actions';
import { DUPLICATE_ACTIONS } from '../media/duplicates-actions';
import { JOB_ACTIONS } from '../jobs/jobs-actions';
import { TORRENT_ACTIONS } from '../torrents/torrents-actions';
import { FILE_ACTIONS } from '../files/files-actions';
import { SUBTITLE_ACTIONS } from '../subtitle-intelligence/subtitle-actions';

/** Any controller class; handlers are looked up on the prototype by name. */
type Ctor = { name: string; prototype: object };

/**
 * Action id → the controller handler it dispatches to.
 *
 * An action reachable through more than one route (a single-item route and a
 * bulk route) lists both: the declaration must satisfy **every** endpoint it
 * can reach, since the surface picks by selection size, not by permission.
 */
const ROUTES: Record<string, Array<[Ctor, string]>> = {
  // --- media -------------------------------------------------------------
  'media.library.scan': [[MediaController, 'scanLibrary']],
  'media.metadata.refresh': [[MediaController, 'bulkRefreshMetadata']],
  'media.nfo.generate': [[MediaController, 'bulkNfo']],
  'media.item.lock': [[MediaController, 'bulkLock']],
  'media.item.unlock': [[MediaController, 'bulkUnlock']],
  'media.item.move': [[MediaController, 'bulkMove']],
  'media.item.remove': [[MediaController, 'bulkRemove']],
  'media.item.deleteFiles': [[MediaController, 'bulkDeleteFiles']],

  // --- duplicates --------------------------------------------------------
  'duplicates.detect': [[MediaController, 'detectDuplicates']],
  'duplicates.ignore': [[MediaController, 'ignoreDuplicateGroup']],
  'duplicates.reopen': [[MediaController, 'reopenDuplicateGroup']],

  // --- jobs --------------------------------------------------------------
  'jobs.cancel': [[PlatformJobsController, 'cancel']],
  'jobs.pause': [[PlatformJobsController, 'pause']],
  'jobs.resume': [[PlatformJobsController, 'resume']],
  'jobs.retry': [[PlatformJobsController, 'retry']],
  'jobs.rerun': [[PlatformJobsController, 'rerun']],
  'jobs.cancelBulk': [[PlatformJobsController, 'bulkCancel']],
  'jobs.retryBulk': [[PlatformJobsController, 'bulkRetry']],
  'jobs.rerunBulk': [[PlatformJobsController, 'bulkRerun']],

  // --- torrents ----------------------------------------------------------
  /*
   * The bulk route guards only on `torrents.view` and re-checks the real
   * permission in TorrentsService, so only the single routes are compared here.
   */
  'torrents.resume': [[TorrentsController, 'resume']],
  'torrents.pause': [[TorrentsController, 'pause']],
  'torrents.stop': [[TorrentsController, 'stop']],
  'torrents.recheck': [[TorrentsController, 'recheck']],
  'torrents.remove': [[TorrentsController, 'remove']],
  'torrents.removeData': [[TorrentsController, 'removeData']],

  // --- subtitles ---------------------------------------------------------
  'subtitles.search': [[SubtitleIntelligenceController, 'search']],
};

/** Handlers whose permissions this gate cannot compare, with the reason why. */
const UNMAPPED: Record<string, string> = {
  'files.open': 'client-side navigation, not an endpoint',
  'files.preview': 'preview is a GET the viewer issues itself',
  'files.download': 'download is a GET the browser issues itself',
  'files.rename': 'dispatched through the rename dialog',
  'files.move': 'single and bulk routes; bulk verified by files-bulk-permissions.spec',
  'files.copy': 'single and bulk routes; bulk verified by files-bulk-permissions.spec',
  'files.cleanup': 'bulk-only; verified by files-bulk-permissions.spec',
  'files.delete': 'single and bulk routes; bulk verified by files-bulk-permissions.spec',
};

const ALL = [
  ...MEDIA_ACTIONS,
  ...DUPLICATE_ACTIONS,
  ...JOB_ACTIONS,
  ...TORRENT_ACTIONS,
  ...FILE_ACTIONS,
  ...SUBTITLE_ACTIONS,
];

function permissionsOf(controller: Ctor, handler: string): string[] {
  const fn = (controller.prototype as Record<string, unknown>)[handler];
  if (typeof fn !== 'function') {
    throw new Error(`${controller.name}.${handler} does not exist`);
  }
  return (Reflect.getMetadata(PERMISSIONS_KEY, fn) as string[] | undefined) ?? [];
}

describe('every action maps to a real endpoint', () => {
  it('accounts for all declared actions — mapped or explicitly unmapped', () => {
    // A new action must be routed or excused here, so this gate cannot be
    // bypassed by simply not adding a mapping.
    const unaccounted = ALL.map((a) => a.id).filter((id) => !ROUTES[id] && !UNMAPPED[id]);
    expect(unaccounted).toEqual([]);
  });

  it('names only handlers that exist', () => {
    for (const [id, routes] of Object.entries(ROUTES)) {
      for (const [controller, handler] of routes) {
        expect(() => permissionsOf(controller, handler)).not.toThrow();
        expect(id).toBeTruthy();
      }
    }
  });
});

describe('declared permissions cover what the endpoint requires', () => {
  /*
   * The direction that matters. A declaration requiring LESS than its endpoint
   * shows a button that 403s — the framework's core promise, broken. Requiring
   * more only hides an action the user could have used, which is a smaller and
   * self-correcting fault.
   */
  const declared = new Map(ALL.map((a) => [a.id, new Set(a.permissions)]));

  for (const [id, routes] of Object.entries(ROUTES)) {
    for (const [controller, handler] of routes) {
      const name = controller.name;
      it(`${id} covers ${name}.${handler}`, () => {
        const required = permissionsOf(controller, handler);
        const held = declared.get(id);
        expect(held).toBeDefined();
        const missing = required.filter((p) => !held!.has(p));
        expect(missing).toEqual([]);
      });
    }
  }
});
