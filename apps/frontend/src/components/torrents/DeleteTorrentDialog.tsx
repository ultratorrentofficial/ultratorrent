import { useState } from 'react';
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

  const target = count === 1 ? (name ? `“${name}”` : 'this torrent') : `${count} torrents`;

  return (
    <Dialog open={open} onClose={onClose} title="Delete torrent" className="max-w-md">
      <DialogHeader>
        <div className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-destructive/10 text-destructive">
          <TriangleAlert className="h-5 w-5" />
        </div>
        <DialogTitle>Delete {count === 1 ? 'torrent' : `${count} torrents`}?</DialogTitle>
        <DialogDescription>
          You are about to remove {target}. This action cannot be undone.
        </DialogDescription>
      </DialogHeader>

      <label className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">Also delete downloaded data</p>
          <p className="text-xs text-muted-foreground">Permanently removes files from disk.</p>
        </div>
        <Switch checked={withData} onCheckedChange={setWithData} aria-label="Delete data" />
      </label>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={handleConfirm} loading={busy}>
          {withData ? 'Delete + data' : 'Delete'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
