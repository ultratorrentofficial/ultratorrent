import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EntityRef } from '@ultratorrent/shared';
import { api, type MediaLibrary } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { ActionBar, type ActionHandler } from '@/actions/ActionBar';
import { useContextActions } from '@/actions/useContextActions';
import { useJobRefresh } from './useJobRefresh';
import { CleanupItemDialog } from './CleanupItemDialog';
import { ConfirmDeleteDialog, type DeleteMode } from './ConfirmDeleteDialog';
import { ItemContextMenu, type ContextMenuAnchor } from './ItemContextMenu';
import { RenameItemDialog } from './RenameItemDialog';
import { MoveToLibraryDialog } from './MoveToLibraryDialog';

type BulkOp = 'metadata' | 'lock' | 'unlock' | 'nfo' | 'remove' | 'delete-files';

/**
 * The Library Browser's action surface — now a projection of the CAMA registry.
 *
 * This component previously hardcoded five buttons and their permission checks.
 * It no longer decides *what* can be done: the server resolves that from the
 * registry against the caller's permissions, module state and provider
 * availability, and `resolveActions` narrows it by the live selection. What
 * remains here is the only thing genuinely local — *how* each action runs.
 *
 * That split is what makes the framework worth having. A module contributing a
 * new media action gets a button here with no change to this file; a permission
 * revoked upstream removes one without a redeploy.
 */
export function ContextActionBar({
  libraryId,
  library,
  selectedIds,
  onClear,
  operationsMode = false,
  contextMenu,
  onCloseContextMenu,
}: {
  libraryId: string;
  /** The open library, for rename settings. Null while it loads. */
  library?: MediaLibrary | null;
  selectedIds: readonly string[];
  onClear: () => void;
  operationsMode?: boolean;
  /**
   * An open right-click menu: where it was opened and what it applies to. The
   * PAGE owns this, because only the grid knows which tile was clicked and
   * whether it was already part of the selection.
   */
  contextMenu?: { anchor: ContextMenuAnchor; item: { id: string; title: string; path: string } } | null;
  onCloseContextMenu?: () => void;
}) {
  const { t } = useTranslation('actions');
  const toast = useToast();
  const qc = useQueryClient();

  /*
   * Selected items as entity refs.
   *
   * Episodes and movies are both `media_item` — the one selectable media entity
   * — because the browser projects hierarchy from flat rows rather than modelling
   * it. Rebuilt whenever the selection changes, which is what drives resolution.
   */
  const selection = useMemo<EntityRef[]>(
    () => selectedIds.map((id) => ({ type: 'media_item', id })),
    [selectedIds],
  );

  const { groups, isLoading, isError } = useContextActions({ selection, operationsMode });

  /*
   * Destructive and destination-taking actions open a dialog instead of firing.
   * The handler map's job is to START the action; for these two, starting it
   * means asking a question first.
   */
  const [confirmMode, setConfirmMode] = useState<DeleteMode | null>(null);
  const [movingOpen, setMovingOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string; path: string } | null>(null);
  const [cleaningIds, setCleaningIds] = useState<string[] | null>(null);
  /*
   * Detached operations finish long after their request returns, so the grid is
   * refreshed on the job's completion event rather than on the response — see
   * `useJobRefresh` for the measurement that made this necessary.
   */
  const watchJob = useJobRefresh(['library-browser']);

  const bulk = useMutation({
    mutationFn: ({ op, ids }: { op: BulkOp; ids: string[] }) => api.media.bulkItems(op, ids),
    onSuccess: (result) => {
      // A job id means the work is still running — saying "done" would be false.
      toast.success(
        result.jobId
          ? t('result.queued', { count: result.accepted })
          : t('result.applied', { count: result.accepted }),
      );
      // Ids that resolved to nothing are surfaced, never swallowed: acting on
      // fewer items than were selected must not look like success.
      if (result.missing.length) toast.error(t('result.missing', { count: result.missing.length }));
      // Synchronous operations are done already; detached ones have not
      // started, so those refresh when their job settles instead.
      if (result.jobId) watchJob(result.jobId);
      else qc.invalidateQueries({ queryKey: ['library-browser'] });
      onClear();
    },
    onError: (e: Error) => toast.error(e?.message || t('result.failed')),
  });

  const scan = useMutation({
    mutationFn: () => api.media.scanLibrary(libraryId),
    onSuccess: () => toast.success(t('result.queued', { count: 1 })),
    onError: (e: Error) => toast.error(e?.message || t('result.failed')),
  });

  const move = useMutation({
    mutationFn: ({ ids, targetLibraryId }: { ids: string[]; targetLibraryId: string }) =>
      api.media.bulkMoveItems(ids, targetLibraryId),
    onSuccess: (result) => {
      toast.success(t('result.queued', { count: result.accepted }));
      if (result.missing.length) toast.error(t('result.missing', { count: result.missing.length }));
      if (result.jobId) watchJob(result.jobId);
      else qc.invalidateQueries({ queryKey: ['library-browser'] });
      setMovingOpen(false);
      onClear();
    },
    onError: (e: Error) => toast.error(e?.message || t('result.failed')),
  });

  /*
   * What this surface knows how to run.
   *
   * Only these ids render. The registry is platform-wide and will resolve
   * actions a surface has not wired up — a subtitle or duplicate action can
   * reach a media selection — and rendering one would be a button that does
   * nothing, which reads as a broken feature rather than a missing one.
   */
  const handlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'media.library.scan': () => scan.mutate(),
      'media.metadata.refresh': (sel) => bulk.mutate({ op: 'metadata', ids: idsOf(sel) }),
      'media.nfo.generate': (sel) => bulk.mutate({ op: 'nfo', ids: idsOf(sel) }),
      'media.item.lock': (sel) => bulk.mutate({ op: 'lock', ids: idsOf(sel) }),
      'media.item.unlock': (sel) => bulk.mutate({ op: 'unlock', ids: idsOf(sel) }),
      // These two ask before they act; the dialog owns the mutation call.
      'media.item.move': () => setMovingOpen(true),
      /*
       * Rename is arity 'one', so the resolver guarantees a single entity — but
       * only the right-click path carries its path, so it falls back to the
       * context target rather than guessing from an id.
       */
      'media.item.rename': (sel) => {
        const target = contextMenu?.item ?? null;
        if (target && (sel.length !== 1 || sel[0].id === target.id)) setRenaming(target);
      },
      'media.cleanup.runItems': (sel) => setCleaningIds(idsOf(sel)),
      'media.item.remove': () => setConfirmMode('remove'),
      'media.item.deleteFiles': () => setConfirmMode('files'),
    }),
    [bulk, scan, contextMenu],
  );

  return (
    <>
      <ActionBar
        groups={groups}
        selection={selection}
        handlers={handlers}
        onClear={onClear}
        busy={bulk.isPending || scan.isPending || move.isPending}
        isLoading={isLoading}
        isError={isError}
        primaryGroups={['metadata', 'maintenance']}
      />
      <ConfirmDeleteDialog
        open={confirmMode !== null}
        mode={confirmMode ?? 'remove'}
        count={selectedIds.length}
        busy={bulk.isPending}
        onClose={() => setConfirmMode(null)}
        onConfirm={() => {
          bulk.mutate({ op: confirmMode === 'files' ? 'delete-files' : 'remove', ids: [...selectedIds] });
          setConfirmMode(null);
        }}
      />
      {contextMenu && onCloseContextMenu && (
        <ItemContextMenu
          anchor={contextMenu.anchor}
          /*
           * Right-clicking a tile inside an existing multi-selection acts on the
           * whole selection; right-clicking outside it acts on that one item.
           * The page has already reconciled the selection, so trusting it here
           * keeps one rule in one place.
           */
          selection={
            selectedIds.includes(contextMenu.item.id) && selectedIds.length > 1
              ? selection
              : [{ type: 'media_item', id: contextMenu.item.id }]
          }
          handlers={handlers}
          onClose={onCloseContextMenu}
        />
      )}
      <RenameItemDialog
        open={renaming !== null}
        item={renaming}
        library={library ?? null}
        onClose={() => setRenaming(null)}
        onApplied={() => {
          toast.success(t('result.applied', { count: 1 }));
          qc.invalidateQueries({ queryKey: ['library-browser'] });
        }}
      />
      <CleanupItemDialog
        open={cleaningIds !== null}
        count={cleaningIds?.length ?? 0}
        itemIds={cleaningIds ?? []}
        onClose={() => setCleaningIds(null)}
      />
      <MoveToLibraryDialog
        open={movingOpen}
        count={selectedIds.length}
        currentLibraryId={libraryId}
        busy={move.isPending}
        onClose={() => setMovingOpen(false)}
        onConfirm={(targetLibraryId) => move.mutate({ ids: [...selectedIds], targetLibraryId })}
      />
    </>
  );
}

const idsOf = (selection: readonly EntityRef[]): string[] => selection.map((e) => e.id);
