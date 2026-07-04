import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';

export interface DeleteTorrentDialogProps {
  open: boolean;
  count: number;
  name?: string;
  onClose: () => void;
  onConfirm: (withData: boolean) => Promise<void> | void;
}

export function DeleteTorrentDialog({ open, count, name, onClose, onConfirm }: DeleteTorrentDialogProps) {
  const { t } = useTranslation('torrents');
  const [withData, setWithData] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm(withData);
    } finally {
      setBusy(false);
    }
  };

  const target =
    count === 1
      ? name
        ? t('delete.targetNamed', { name })
        : t('delete.targetThis')
      : t('delete.targetMany', { count });

  return (
    <Dialog open={open} onClose={onClose} title={t('delete.title')} className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-destructive/10 text-destructive">
          <TriangleAlert className="h-5 w-5" />
        </div>
        <DialogTitle>{t('delete.heading', { count })}</DialogTitle>
        <DialogDescription>
          {t('delete.body', { target })}
        </DialogDescription>
      </DialogHeader>

      <label className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">{t('delete.alsoData')}</p>
          <p className="text-xs text-muted-foreground">{t('delete.alsoDataHint')}</p>
        </div>
        <Switch checked={withData} onCheckedChange={setWithData} aria-label={t('delete.dataAria')} />
      </label>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('delete.cancel')}
        </Button>
        <Button variant="destructive" onClick={handleConfirm} loading={busy}>
          {withData ? t('delete.confirmData') : t('delete.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
