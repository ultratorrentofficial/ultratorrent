/**
 * What can be done to a file or folder.
 *
 * The File Manager already gates every action on its own permission — its
 * context menu is the most carefully gated surface in the app, checking seven
 * distinct permissions per entry. What it does not do is share that reasoning
 * with the bulk toolbar beside it, or with anything else that will later act on
 * files.
 *
 * The interesting part here is `requiresEntityCapability`: a folder and a file
 * admit different work. Previewing a directory is meaningless, and the context
 * menu already branched on `node.isDirectory` inline. That branch becomes an
 * advertised capability, so the rule lives with the entity rather than in the
 * one surface that remembered to check.
 */
import { PERMISSIONS } from '@ultratorrent/shared';
import type { ActionDescriptor, EntityType } from '@ultratorrent/shared';

const P = PERMISSIONS;

/**
 * Tokens a file entry advertises. `openable` is a directory; `readable` is a
 * file whose bytes can be shown or fetched.
 */
export const FILE_CAPABILITY_TOKENS = ['openable', 'readable'] as const;

const base = {
  entityTypes: ['file'] as EntityType[],
  module: 'files',
};

export const FILE_ACTIONS: ActionDescriptor[] = [
  {
    ...base,
    id: 'files.open',
    group: 'media',
    arity: 'single',
    permissions: [P.FILES_VIEW],
    requiresEntityCapability: 'openable',
    icon: 'FolderOpen',
    order: 10,
  },
  {
    ...base,
    id: 'files.preview',
    group: 'media',
    arity: 'single',
    permissions: [P.FILES_PREVIEW],
    requiresEntityCapability: 'readable',
    icon: 'Eye',
    order: 20,
  },
  {
    ...base,
    id: 'files.download',
    group: 'export',
    arity: 'single',
    permissions: [P.FILES_DOWNLOAD],
    requiresEntityCapability: 'readable',
    icon: 'Download',
    order: 10,
  },
  {
    ...base,
    id: 'files.rename',
    group: 'maintenance',
    // Renaming is inherently one-at-a-time: a new name cannot be shared.
    arity: 'single',
    permissions: [P.FILES_RENAME],
    icon: 'PenLine',
    order: 10,
  },
  {
    ...base,
    id: 'files.move',
    group: 'maintenance',
    arity: 'any',
    permissions: [P.FILES_MOVE, P.FILES_BULK_ACTIONS],
    icon: 'FolderInput',
    order: 20,
  },
  {
    ...base,
    id: 'files.copy',
    group: 'maintenance',
    arity: 'any',
    permissions: [P.FILES_COPY, P.FILES_BULK_ACTIONS],
    icon: 'Copy',
    order: 30,
  },
  {
    /*
     * Cleanup dispatches through POST files/bulk with operation 'cleanup',
     * which deletes. It therefore requires `files.delete`, not the weaker
     * `files.cleanup` — that permission governs the separate scan/preview
     * routes, which take a folder and candidate list rather than a selection.
     */
    ...base,
    id: 'files.cleanup',
    group: 'maintenance',
    arity: 'any',
    permissions: [P.FILES_DELETE, P.FILES_BULK_ACTIONS],
    icon: 'Sparkles',
    order: 40,
  },
  {
    /*
     * Delete goes to trash and is recoverable, so it is not marked
     * operations-only — but it is destructive, and the surface confirms it.
     *
     * `files.bulk_actions` is required alongside `files.delete` because the
     * client switches to POST files/bulk above one item, and that route guards
     * on it. Declaring only `files.delete` gave a working single delete and a
     * 403 the moment a second file was selected.
     */
    ...base,
    id: 'files.delete',
    group: 'maintenance',
    arity: 'any',
    permissions: [P.FILES_DELETE, P.FILES_BULK_ACTIONS],
    destructive: true,
    icon: 'Trash2',
    order: 90,
  },
];
