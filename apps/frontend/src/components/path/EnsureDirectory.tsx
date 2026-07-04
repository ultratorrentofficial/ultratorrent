import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderPlus } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

/**
 * Reusable "before you save a directory path" gate. Call `ensure(path)` at the
 * top of a form's submit handler and render `dialog` somewhere in the tree:
 *
 *   const { ensure, dialog } = useEnsureDirectory();
 *   const submit = async () => {
 *     if (!(await ensure(path))) return;   // aborted (outside roots / declined)
 *     await api.save(...);
 *   };
 *   return (<>{form}{dialog}</>);
 *
 * `ensure` resolves to `true` when the caller should proceed and `false` when
 * the save must be aborted. It:
 *   - validates the path is inside the ops hard roots (rejects otherwise);
 *   - when the path is allowed but missing, opens a modal offering to create it
 *     (recursively) and only resolves `true` once it exists;
 *   - fails open (returns `true`) if the path can't be inspected — e.g. the user
 *     lacks files permission — since the server still enforces containment.
 */
export function useEnsureDirectory() {
  const { t } = useTranslation('files');
  const toast = useToast();
  const [target, setTarget] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const resolver = useRef<((proceed: boolean) => void) | null>(null);

  const settle = useCallback((proceed: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setTarget(null);
    setCreating(false);
    resolve?.(proceed);
  }, []);

  const ensure = useCallback(
    async (rawPath: string): Promise<boolean> => {
      const value = rawPath.trim();
      if (!value) return true; // let the form's own required-field check handle empties

      let info;
      try {
        info = await api.files.inspectPath(value);
      } catch {
        // Can't inspect (offline / no permission) — don't block; the server
        // still validates containment on save.
        return true;
      }

      if (info.isSystemDir || !info.withinHardRoots) {
        toast.error(t('ensureDir.outsideRootsTitle'), t('ensureDir.outsideRootsBody'));
        return false;
      }
      if (info.exists) {
        if (!info.isDirectory) {
          toast.error(t('ensureDir.notDirTitle'), t('ensureDir.notDirBody'));
          return false;
        }
        return true;
      }

      // Allowed but missing — ask whether to create it.
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setTarget(info.path);
      });
    },
    [t, toast],
  );

  const confirmCreate = useCallback(async () => {
    if (!target) return;
    setCreating(true);
    try {
      await api.files.ensureDir(target);
      toast.success(t('ensureDir.createdTitle'), target);
      settle(true);
    } catch (err) {
      toast.error(t('ensureDir.createError'), err instanceof ApiError ? err.message : undefined);
      setCreating(false); // keep the dialog open to retry or cancel
    }
  }, [target, t, toast, settle]);

  const dialog = target ? (
    <Dialog open onClose={() => settle(false)} title={t('ensureDir.title')} className="max-w-md">
      <DialogHeader>
        <div className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <FolderPlus className="h-5 w-5" />
        </div>
        <DialogTitle>{t('ensureDir.title')}</DialogTitle>
        <DialogDescription>{t('ensureDir.description')}</DialogDescription>
      </DialogHeader>
      <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs break-all">
        {target}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => settle(false)} disabled={creating}>
          {t('ensureDir.cancel')}
        </Button>
        <Button onClick={confirmCreate} loading={creating}>
          {t('ensureDir.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  ) : null;

  return { ensure, dialog };
}
