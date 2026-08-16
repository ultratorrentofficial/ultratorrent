import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type DeleteSourceAction } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';

export type DeleteMode = 'remove' | 'files';

/**
 * Confirmation for the two deletes, which differ in what they cost.
 *
 * `remove` drops library rows and leaves the media alone, so it gets an
 * ordinary confirm — and says plainly that a rescan brings the items back,
 * because an operator who expects the files gone would otherwise read a
 * successful removal as one.
 *
 * `files` erases media from disk and cannot be undone, so it asks the operator
 * to **type the item count** before the button enables. The friction is the
 * point: it is the difference between acknowledging a dialog and reading it,
 * and it is calibrated to the selection rather than a fixed word, so
 * confirming forty deletions cannot become muscle memory for confirming one.
 */
export function ConfirmDeleteDialog({
  open,
  mode,
  count,
  itemIds,
  onClose,
  onConfirm,
  busy,
}: {
  open: boolean;
  mode: DeleteMode;
  count: number;
  /** The selection, so the dialog can ask what it would strand. */
  itemIds?: string[];
  onClose: () => void;
  onConfirm: (sourceAction: DeleteSourceAction) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation('actions');
  const [typed, setTyped] = useState('');
  const [sourceAction, setSourceAction] = useState<DeleteSourceAction>('keep');
  const destructive = mode === 'files';
  const armed = !destructive || typed.trim() === String(count);

  /*
   * Only the destructive mode asks: `remove` leaves the media alone, so no
   * torrent is affected and the question would be noise.
   */
  const { data } = useQuery({
    queryKey: ['media', 'delete-files', 'preview', itemIds],
    queryFn: () => api.media.deleteFilesPreview(itemIds ?? []),
    enabled: open && destructive && (itemIds?.length ?? 0) > 0,
    staleTime: 0,
  });
  const torrents = data?.torrents ?? [];
  const reclaimable = torrents.reduce((sum, x) => sum + (x.sizeBytes || 0), 0);

  const close = () => {
    setTyped('');
    setSourceAction('keep');
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={destructive ? t('delete.filesTitle') : t('delete.removeTitle')}
    >
      <DialogDescription>
        {destructive ? t('delete.filesBody', { count }) : t('delete.removeBody', { count })}
      </DialogDescription>
      {destructive && torrents.length > 0 && (
        /*
         * The gap this closes: the library copy of a hardlink import is one of
         * two links. Deleting it left the payload and a live seed behind with
         * nothing pointing at them, and the dialog gave no hint that was
         * happening — so the operator had no way to know without going and
         * looking in the torrent client.
         */
        <div className="my-2 space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3">
          <div className="text-sm font-medium">{t('delete.sourceTitle')}</div>
          <p className="text-xs text-muted-foreground">
            {t('delete.sourceIntro', { count: torrents.length })}
            {reclaimable > 0 && <> · {t('delete.sourceReclaim', { size: formatBytes(reclaimable) })}</>}
          </p>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
            {torrents.map((x) => (
              <li key={x.torrentHash} className="flex items-baseline justify-between gap-3">
                <span className="truncate" title={x.sourcePath}>{x.name}</span>
                <span className="shrink-0 tabular-nums">
                  {x.sizeBytes > 0 ? formatBytes(x.sizeBytes) : t('delete.sourceUnknownSize')}
                </span>
              </li>
            ))}
          </ul>
          <div className="space-y-1.5 pt-1">
            {([
              ['keep', 'delete.sourceKeep', 'delete.sourceKeepHint'],
              ['stop', 'delete.sourceStop', 'delete.sourceStopHint'],
              ['stop_and_delete', 'delete.sourceStopDelete', 'delete.sourceStopDeleteHint'],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="radio"
                  name="delete-source-action"
                  className="mt-0.5"
                  checked={sourceAction === value}
                  onChange={() => setSourceAction(value)}
                />
                <span>
                  <span className="font-medium text-foreground">{t(label)}</span>
                  <span className="block text-muted-foreground">{t(hint)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {destructive && (
        <div className="space-y-1.5 py-2">
          <Label htmlFor="confirm-count">{t('delete.typeCount', { count })}</Label>
          <Input
            id="confirm-count"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            inputMode="numeric"
          />
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          {t('confirm.cancel')}
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'primary'}
          disabled={!armed || busy}
          onClick={() => onConfirm(destructive ? sourceAction : 'keep')}
        >
          {destructive ? t('delete.filesSubmit') : t('delete.removeSubmit')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
