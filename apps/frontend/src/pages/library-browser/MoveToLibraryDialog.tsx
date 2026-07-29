import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/input';


/**
 * Where to move a selection.
 *
 * "Move to another library" is a reassignment *and* a file move, so the choice
 * is a library rather than a folder — the destination root comes from the
 * library, which is what keeps the moved items out of the old library's next
 * scan. The library the items already live in is excluded: offering it would
 * be a no-op dressed as a destination.
 */
export function MoveToLibraryDialog({
  open,
  onClose,
  onConfirm,
  count,
  currentLibraryId,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (targetLibraryId: string) => void;
  count: number;
  currentLibraryId: string;
  busy?: boolean;
}) {
  const { t } = useTranslation('actions');
  const [target, setTarget] = useState('');
  const libraries = useQuery({
    queryKey: ['media', 'libraries'],
    queryFn: () => api.media.listLibraries(),
    enabled: open,
  });

  const options = useMemo(
    () => (libraries.data ?? []).filter((l) => l.id !== currentLibraryId),
    [libraries.data, currentLibraryId],
  );

  return (
    <Dialog open={open} onClose={onClose} title={t('move.title')}>
      <DialogDescription>{t('move.body', { count })}</DialogDescription>
      <div className="space-y-1.5 py-2">
        <Label htmlFor="move-target">{t('move.destination')}</Label>
        <select
          id="move-target"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">{t('move.choose')}</option>
          {options.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        {/* A library with nowhere to move to is a dead end worth naming. */}
        {libraries.isSuccess && options.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('move.noTargets')}</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('confirm.cancel')}
        </Button>
        <Button disabled={!target || busy} onClick={() => onConfirm(target)}>
          {t('move.submit')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
