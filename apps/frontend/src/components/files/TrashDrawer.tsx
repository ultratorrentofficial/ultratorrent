import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { File as FileIcon, Folder, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { formatBytes, formatRelativeTime, pluralize } from '@/lib/format';

/** Trash Browser: list soft-deleted items, restore, permanently purge, empty. */
export function TrashDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['files-trash'],
    queryFn: () => api.files.trash.list(),
    enabled: open,
  });

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['files-trash'] }),
      qc.invalidateQueries({ queryKey: ['files'] }),
    ]);
  };

  const restore = async (id: string) => {
    setBusyId(id);
    try {
      await api.files.trash.restore(id);
      toast.success('Restored');
      await refresh();
    } catch (err) {
      toast.error('Restore failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (id: string) => {
    if (!window.confirm('Permanently delete this item? This cannot be undone.')) return;
    setBusyId(id);
    try {
      await api.files.trash.purge(id);
      toast.success('Permanently deleted');
      await refresh();
    } catch (err) {
      toast.error('Delete failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const empty = async () => {
    try {
      const res = await api.files.trash.empty();
      toast.success(`Emptied Trash`, `${pluralize(res.removed, 'item')} removed`);
      await refresh();
    } catch (err) {
      toast.error('Empty Trash failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setConfirmEmpty(false);
    }
  };

  const items = data ?? [];
  return (
    <Drawer open={open} onClose={onClose} title="Trash" className="max-w-xl">
      <DrawerHeader onClose={onClose}>
        <div className="flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-lg font-semibold">Trash</h2>
            <p className="text-xs text-muted-foreground">{pluralize(items.length, 'item')}</p>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody className="space-y-1">
        {isLoading ? (
          <CenteredSpinner label="Loading trash…" />
        ) : items.length === 0 ? (
          <EmptyState icon={<Trash2 className="h-6 w-6" />} title="Trash is empty" />
        ) : (
          <ul className="divide-y divide-border/40">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                {item.isDirectory ? (
                  <Folder className="h-5 w-5 shrink-0 text-primary" />
                ) : (
                  <FileIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.originalPath} · {formatBytes(item.size)} · {formatRelativeTime(item.deletedAt)}
                  </p>
                </div>
                <Button size="sm" variant="ghost" loading={busyId === item.id} onClick={() => restore(item.id)}>
                  <RotateCcw className="h-4 w-4" /> Restore
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10"
                  disabled={busyId === item.id}
                  onClick={() => purge(item.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DrawerBody>

      <DrawerFooter className="justify-between">
        <Button variant="ghost" size="sm" onClick={() => refetch()}>Refresh</Button>
        {confirmEmpty ? (
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4" /> Delete all permanently?
            </span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmEmpty(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={empty}>Confirm</Button>
          </span>
        ) : (
          <Button variant="destructive" size="sm" disabled={items.length === 0} onClick={() => setConfirmEmpty(true)}>
            <Trash2 className="h-4 w-4" /> Empty Trash
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
