import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EntityRef } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { ActionBar, type ActionHandler } from '@/actions/ActionBar';
import { useContextActions } from '@/actions/useContextActions';
import { useJobRefresh } from './useJobRefresh';
import { ConfirmDeleteDialog, type DeleteMode } from './ConfirmDeleteDialog';
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
  selectedIds,
  onClear,
  operationsMode = false,
}: {
  libraryId: string;
  selectedIds: readonly string[];
  onClear: () => void;
  operationsMode?: boolean;
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
      'media.item.remove': () => setConfirmMode('remove'),
      'media.item.deleteFiles': () => setConfirmMode('files'),
    }),
    [bulk, scan],
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
