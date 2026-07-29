import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  onClose,
  onConfirm,
  busy,
}: {
  open: boolean;
  mode: DeleteMode;
  count: number;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation('actions');
  const [typed, setTyped] = useState('');
  const destructive = mode === 'files';
  const armed = !destructive || typed.trim() === String(count);

  const close = () => {
    setTyped('');
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
          onClick={onConfirm}
        >
          {destructive ? t('delete.filesSubmit') : t('delete.removeSubmit')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
