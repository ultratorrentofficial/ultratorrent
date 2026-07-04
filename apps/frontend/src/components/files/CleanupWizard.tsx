import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles, TriangleAlert } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import type { CleanupPreview } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { formatBytes } from '@/lib/format';

/**
 * Cleanup Wizard: scans the current folder, groups candidates by category with
 * per-item selection, shows recoverable space, and executes the selected items
 * (Trash by default, with an explicit permanent toggle + confirmation).
 */
export function CleanupWizard({
  open,
  path,
  onClose,
}: {
  open: boolean;
  path: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('files');
  const toast = useToast();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [permanent, setPermanent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [executing, setExecuting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setSelected(new Set());
    setPermanent(false);
    setConfirming(false);
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path]);

  const scan = async () => {
    setScanning(true);
    try {
      const result = await api.files.cleanupPreview(path);
      setPreview(result);
      // Pre-select everything by default.
      setSelected(new Set(result.categories.flatMap((c) => c.items.map((i) => i.path))));
    } catch (err) {
      toast.error(t('cleanup.scanFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setScanning(false);
    }
  };

  const allPaths = useMemo(
    () => preview?.categories.flatMap((c) => c.items.map((i) => i.path)) ?? [],
    [preview],
  );
  const selectedSize = useMemo(() => {
    if (!preview) return 0;
    let total = 0;
    for (const c of preview.categories) for (const i of c.items) if (selected.has(i.path)) total += i.size;
    return total;
  }, [preview, selected]);

  const toggle = (p: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });

  const toggleCategory = (paths: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      paths.forEach((p) => (on ? next.add(p) : next.delete(p)));
      return next;
    });

  const execute = async () => {
    setExecuting(true);
    try {
      const res = await api.files.cleanupExecute(path, [...selected], permanent);
      toast.success(
        t('cleanup.cleanedToast', { count: res.removed }),
        res.failed
          ? t('cleanup.reclaimedWithFailed', { size: formatBytes(res.bytesReclaimed), count: res.failed })
          : t('cleanup.reclaimed', { size: formatBytes(res.bytesReclaimed) }),
      );
      await qc.invalidateQueries({ queryKey: ['files'] });
      onClose();
    } catch (err) {
      toast.error(t('cleanup.cleanupFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setExecuting(false);
      setConfirming(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={t('cleanup.title')} className="max-w-2xl">
      <DrawerHeader onClose={onClose}>
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">{t('cleanup.title')}</h2>
            <p className="truncate text-xs text-muted-foreground">{path}</p>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody className="space-y-4">
        {scanning ? (
          <CenteredSpinner label={t('cleanup.scanning')} />
        ) : !preview || preview.totalItems === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-6 w-6" />}
            title={t('cleanup.emptyTitle')}
            description={t('cleanup.emptyDescription')}
          />
        ) : (
          <>
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-white/[0.02] px-4 py-3">
              <div className="text-sm">
                <p className="font-medium">{t('cleanup.candidatesFound', { count: preview.totalItems })}</p>
                <p className="text-xs text-muted-foreground">{t('cleanup.recoverable', { size: formatBytes(preview.estimatedSpaceSaved) })}</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(allPaths))}>{t('cleanup.selectAll')}</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t('cleanup.none')}</Button>
              </div>
            </div>

            {preview.categories.map((group) => {
              const groupPaths = group.items.map((i) => i.path);
              const selectedInGroup = groupPaths.filter((p) => selected.has(p)).length;
              return (
                <div key={group.category} className="rounded-lg border border-border/60">
                  <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedInGroup === groupPaths.length}
                        indeterminate={selectedInGroup > 0 && selectedInGroup < groupPaths.length}
                        onCheckedChange={(on) => toggleCategory(groupPaths, on)}
                        aria-label={t('cleanup.selectGroup', { label: group.label })}
                      />
                      <span className="text-sm font-medium">{group.label}</span>
                      <Badge variant="secondary">{group.itemCount}</Badge>
                    </label>
                    <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(group.totalSize)}</span>
                  </div>
                  <ul className="divide-y divide-border/40">
                    {group.items.map((item) => (
                      <li key={item.path} className="flex items-center gap-3 px-3 py-2">
                        <Checkbox checked={selected.has(item.path)} onCheckedChange={() => toggle(item.path)} aria-label={t('cleanup.selectItem', { name: item.name })} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{item.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{item.reason}</p>
                        </div>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(item.size)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </>
        )}
      </DrawerBody>

      <DrawerFooter className="flex-col items-stretch gap-3">
        {confirming ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <span className="flex items-center gap-2 text-sm">
              <TriangleAlert className="h-4 w-4 text-destructive" />
              {permanent
                ? t('cleanup.confirmPermanent', { count: selected.size })
                : t('cleanup.confirmTrash', { count: selected.size })}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={executing}>{t('cleanup.cancel')}</Button>
              <Button size="sm" variant="destructive" onClick={execute} loading={executing}>{t('cleanup.confirm')}</Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={permanent} onCheckedChange={setPermanent} aria-label={t('cleanup.deletePermanentlyAria')} />
              {t('cleanup.deletePermanently')}
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{t('cleanup.selectedSummary', { count: selected.size, size: formatBytes(selectedSize) })}</span>
              <Button variant="destructive" disabled={selected.size === 0} onClick={() => setConfirming(true)}>
                {t('cleanup.cleanUp')}
              </Button>
            </div>
          </div>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
