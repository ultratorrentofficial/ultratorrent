import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { File as FileIcon, Folder, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { TrashCountdown } from '@/components/files/TrashCountdown';

/** Trash Browser: list soft-deleted items, restore, permanently purge, empty. */
export function TrashDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('files');
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

  // An elapsed countdown means the server now withholds that row — refetch so it
  // leaves the drawer the instant it stops being restorable.
  const expire = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['files-trash'] });
  }, [qc]);

  const restore = async (id: string) => {
    setBusyId(id);
    try {
      await api.files.trash.restore(id);
      toast.success(t('trash.restored'));
      await refresh();
    } catch (err) {
      toast.error(t('trash.restoreFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (id: string) => {
    if (!window.confirm(t('trash.purgeConfirm'))) return;
    setBusyId(id);
    try {
      await api.files.trash.purge(id);
      toast.success(t('trash.purgedToast'));
      await refresh();
    } catch (err) {
      toast.error(t('trash.deleteFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const empty = async () => {
    try {
      const res = await api.files.trash.empty();
      toast.success(t('trash.emptiedToast'), t('trash.removedToast', { count: res.removed }));
      await refresh();
    } catch (err) {
      toast.error(t('trash.emptyFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setConfirmEmpty(false);
    }
  };

  const items = data ?? [];
  return (
    <Drawer open={open} onClose={onClose} title={t('trash.title')} className="max-w-xl">
      <DrawerHeader onClose={onClose}>
        <div className="flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-lg font-semibold">{t('trash.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('trash.count', { count: items.length })}</p>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody className="space-y-1">
        {isLoading ? (
          <CenteredSpinner label={t('trash.loading')} />
        ) : items.length === 0 ? (
          <EmptyState icon={<Trash2 className="h-6 w-6" />} title={t('trash.empty')} />
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
                  <TrashCountdown
                    expiresAt={item.expiresAt}
                    onExpire={expire}
                    className="truncate text-xs text-muted-foreground"
                  />
                </div>
                <Button size="sm" variant="ghost" loading={busyId === item.id} onClick={() => restore(item.id)}>
                  <RotateCcw className="h-4 w-4" /> {t('trash.restore')}
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
        <Button variant="ghost" size="sm" onClick={() => refetch()}>{t('trash.refresh')}</Button>
        {confirmEmpty ? (
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4" /> {t('trash.deleteAllConfirm')}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmEmpty(false)}>{t('trash.cancel')}</Button>
            <Button size="sm" variant="destructive" onClick={empty}>{t('trash.confirm')}</Button>
          </span>
        ) : (
          <Button variant="destructive" size="sm" disabled={items.length === 0} onClick={() => setConfirmEmpty(true)}>
            <Trash2 className="h-4 w-4" /> {t('trash.emptyTrash')}
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
