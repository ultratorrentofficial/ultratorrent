import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { api, type TorrentImportedItem } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';

export interface DeleteTorrentDialogProps {
  open: boolean;
  count: number;
  name?: string;
  /** Hashes being deleted — used to ask what else would be affected. */
  hashes?: string[];
  onClose: () => void;
  onConfirm: (withData: boolean, alsoLibrary: boolean) => Promise<void> | void;
}

/**
 * Deleting a torrent's data does not delete what it put in your library.
 *
 * Media Intake imports by HARDLINK, so the library holds its own name for the
 * same bytes. Unlinking the download's name frees nothing and leaves a complete,
 * playable file — which is exactly what happened to "Time and Water" and
 * "Maddie's Secret": both survived a delete-with-data and had to be removed a
 * second time through Library Browser, after Plex had gone on offering them.
 *
 * So the dialog asks. It asks only when there is something to ask about — the
 * question appears once the data switch is on AND this torrent actually imported
 * something — and it names the titles, because "also remove from library" means
 * nothing without knowing what that is. It is NOT pre-selected: a hardlink import
 * exists so a library copy can outlive the torrent, and defaulting to destruction
 * would break seeding-and-keeping for everyone who relies on it.
 */
export function DeleteTorrentDialog({ open, count, name, hashes, onClose, onConfirm }: DeleteTorrentDialogProps) {
  const { t } = useTranslation('torrents');
  const [withData, setWithData] = useState(false);
  const [alsoLibrary, setAlsoLibrary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<TorrentImportedItem[]>([]);

  // Asked when the dialog opens, not on every keystroke of state: it is a read
  // against the intake table, and the answer cannot change while it is open.
  useEffect(() => {
    if (!open || !hashes?.length) {
      setImported([]);
      return;
    }
    let cancelled = false;
    void api.torrents
      .importedItems(hashes)
      .then((r) => { if (!cancelled) setImported(r); })
      // A failed lookup must not block a delete. The switch simply does not
      // appear, which is exactly the behaviour before this existed.
      .catch(() => { if (!cancelled) setImported([]); });
    return () => { cancelled = true; };
  }, [open, hashes]);

  // Reset between openings so a previous answer cannot carry into a new target.
  useEffect(() => {
    if (!open) { setWithData(false); setAlsoLibrary(false); }
  }, [open]);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm(withData, withData && alsoLibrary);
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

      {withData && imported.length > 0 ? (
        <label className="mt-2 flex items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('delete.alsoLibrary')}</p>
            <p className="text-xs text-muted-foreground">
              {t('delete.alsoLibraryHint', { count: imported.length })}
            </p>
            <ul className="mt-1 space-y-0.5">
              {imported.slice(0, 4).map((i) => (
                <li key={i.itemId} className="truncate text-xs text-foreground/80">
                  {i.title}
                  {i.library ? <span className="text-muted-foreground"> — {i.library}</span> : null}
                </li>
              ))}
              {imported.length > 4 ? (
                <li className="text-xs text-muted-foreground">
                  {t('delete.alsoLibraryMore', { count: imported.length - 4 })}
                </li>
              ) : null}
            </ul>
          </div>
          <Switch
            checked={alsoLibrary}
            onCheckedChange={setAlsoLibrary}
            aria-label={t('delete.libraryAria')}
          />
        </label>
      ) : null}

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
