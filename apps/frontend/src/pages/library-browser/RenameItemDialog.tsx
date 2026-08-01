import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, type MediaLibrary, type RenameRequest } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter } from '@/components/ui/dialog';

/**
 * Rename one item, preview first.
 *
 * `POST media/apply` **moves files**, so the plan comes from `POST
 * media/preview` with the identical request and is shown before anything is
 * applied — a rename that silently reorganised a film is indistinguishable from
 * losing it. This is also why the action is `arity: 'single'`: the endpoint takes a
 * single `path`, so a selection has nothing coherent to preview.
 *
 * The rename settings are the **library's** (`preset`, `mode`, `template`,
 * `libraryPath`), not this dialog's. Letting the browser invent them would let
 * a right-click rename a file by different rules than a library scan would,
 * which is the sort of divergence nobody discovers until the names disagree.
 */
export function RenameItemDialog({
  open,
  item,
  library,
  onClose,
  onApplied,
}: {
  open: boolean;
  item: { id: string; title: string; path: string } | null;
  library: MediaLibrary | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation('actions');

  const body = useMemo<RenameRequest | null>(
    () =>
      item && library
        ? {
            path: item.path,
            preset: library.preset,
            mode: library.mode,
            libraryPath: library.path,
            template: library.template ?? undefined,
          }
        : null,
    [item, library],
  );

  const preview = useQuery({
    queryKey: ['rename-preview', item?.id],
    // `dryRun`, not `mode: 'preview'` — the latter re-roots destinations under the
    // library instead of reusing the file's own show folder, so the dialog would
    // show a move that Apply would never make. See RenameRequest.dryRun.
    queryFn: () => api.media.preview({ ...body!, dryRun: true }),
    enabled: open && !!body,
    retry: false,
  });

  const apply = useMutation({
    mutationFn: () => api.media.apply(body!),
    onSuccess: () => {
      onApplied();
      onClose();
    },
  });

  /*
   * Only the rows that would actually move. `unchanged` files are already at
   * their destination and `skipped` ones were excluded by the plan — listing
   * them would pad the preview with lines that are not the operation.
   */
  const rows = useMemo(
    () => (preview.data?.items ?? []).filter((i) => !i.unchanged && !i.skipped),
    [preview.data],
  );

  return (
    <Dialog open={open} onClose={onClose} title={t('rename.title')}>
      <DialogDescription>{t('rename.body', { title: item?.title ?? '' })}</DialogDescription>

      <div className="max-h-64 overflow-auto py-2 text-xs">
        {preview.isLoading && <p className="text-muted-foreground">{t('rename.loading')}</p>}
        {preview.isError && (
          <p className="text-destructive">
            {preview.error instanceof ApiError ? preview.error.message : t('rename.previewFailed')}
          </p>
        )}
        {/* Distinguished from a failure on purpose: "already correct" and
            "could not be computed" look the same as an empty list. */}
        {preview.isSuccess && rows.length === 0 && (
          <p className="text-muted-foreground">{t('rename.noChanges')}</p>
        )}
        {rows.map((row, i) => (
          <div key={i} className="border-b border-border/50 py-1.5 last:border-0">
            <div className="truncate text-muted-foreground line-through">{row.source}</div>
            <div className="truncate text-foreground">{row.destination ?? '—'}</div>
          </div>
        ))}
        {preview.data?.warnings?.map((w) => (
          <p key={w} className="pt-1 text-amber-500">{w}</p>
        ))}
      </div>

      {apply.isError && (
        <p className="text-xs text-destructive">
          {apply.error instanceof ApiError ? apply.error.message : t('result.failed')}
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('confirm.cancel')}</Button>
        {/* Nothing to apply is not a reason to offer Apply. */}
        <Button disabled={!rows.length || apply.isPending} onClick={() => apply.mutate()}>
          {t('rename.submit')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
