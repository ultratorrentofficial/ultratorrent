import { useMemo } from 'react';
import type { EntityRef } from '@ultratorrent/shared';
import { ActionBar, type ActionHandler } from '@/actions/ActionBar';
import { useContextActions } from '@/actions/useContextActions';

export interface FilesBulkToolbarProps {
  /** The selected entries, each advertising what it is. */
  selection: EntityRef[];
  onMove: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onCleanup: () => void;
  onClear: () => void;
  cleanupBusy?: boolean;
}

/**
 * Bulk actions over selected files, resolved from the CAMA catalogue.
 *
 * The File Manager was already the best-gated surface in the app — this bar
 * checked four permissions and the context menu seven — so nothing here is a
 * repair. What it gains is sharing: the same declarations now serve this bar,
 * the context menu, and anything added later, instead of three places each
 * remembering the same seven checks.
 *
 * Actions needing exactly one entry (rename, preview, download, open) resolve
 * away on a multi-selection without this component knowing they exist.
 */
export function FilesBulkToolbar({
  selection,
  onMove,
  onCopy,
  onDelete,
  onCleanup,
  onClear,
  cleanupBusy,
}: FilesBulkToolbarProps) {
  const { groups, isLoading, isError } = useContextActions({ selection });

  const handlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'files.move': onMove,
      'files.copy': onCopy,
      'files.delete': onDelete,
      'files.cleanup': onCleanup,
    }),
    [onMove, onCopy, onDelete, onCleanup],
  );

  if (selection.length === 0) return null;

  return (
    <ActionBar
      groups={groups}
      selection={selection}
      handlers={handlers}
      onClear={onClear}
      busy={cleanupBusy}
      isLoading={isLoading}
      isError={isError}
      primaryGroups={['maintenance']}
    />
  );
}
