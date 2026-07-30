import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/feedback';

/** Everything after the last separator — the part that actually changed. */
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
/** The directory, shown small: two long absolute paths hide the difference. */
const dirName = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

/**
 * What a rename run did, file by file.
 *
 * The Undo list answered "when, and how many" but never "what" — so deciding
 * whether a rename was wrong meant undoing it to find out, which is the one
 * thing an operator is trying to avoid. The old and new paths were recorded on
 * every operation from the start; nothing displayed them.
 *
 * Shown as `old → new` with the **basename emphasised and the directory
 * demoted**, because in a rename the directory is usually identical and two
 * full absolute paths bury the single difference the reader is looking for.
 * When the directory *does* change — a move — it is right there under each side.
 */
export function RenameRunDetail({ runId }: { runId: string }) {
  const { t } = useTranslation('media');
  const detail = useQuery({
    queryKey: ['media', 'rename', 'run', runId],
    queryFn: () => api.media.renameRunOperations(runId),
  });

  if (detail.isLoading) return <Skeleton className="h-16 w-full" />;
  if (detail.isError) {
    return <p className="px-3 py-2 text-xs text-destructive">{t('rename.undo.detailFailed')}</p>;
  }

  const ops = detail.data?.operations ?? [];
  if (!ops.length) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t('rename.undo.detailEmpty')}</p>;
  }

  return (
    <div className="space-y-1 border-t border-white/10 px-3 py-2">
      {ops.map((op) => (
        <div key={op.id} className="grid gap-1 py-1 text-xs sm:grid-cols-[1fr,auto,1fr] sm:items-center">
          <div className="min-w-0">
            <p className="truncate font-mono text-muted-foreground line-through">{baseName(op.source)}</p>
            <p className="truncate text-[10px] text-muted-foreground/60">{dirName(op.source)}</p>
          </div>
          <ArrowRight className="hidden h-3 w-3 shrink-0 text-muted-foreground sm:block" aria-hidden />
          <div className="min-w-0">
            {/* A delete or a skip has no destination; an em dash beats an empty cell. */}
            <p className="truncate font-mono text-foreground">
              {op.destination ? baseName(op.destination) : '—'}
            </p>
            {op.destination && (
              <p className="truncate text-[10px] text-muted-foreground/60">{dirName(op.destination)}</p>
            )}
          </div>
          {/* Only the exceptions are labelled; tagging every successful row
              "success" would be noise on the common case. */}
          {(op.status !== 'success' || op.undoneAt) && (
            <p className="text-[10px] text-amber-500 sm:col-span-3">
              {op.undoneAt ? t('rename.undo.alreadyUndone') : `${op.status}${op.message ? ` · ${op.message}` : ''}`}
            </p>
          )}
        </div>
      ))}
      {/* A capped list must never read as the whole run. */}
      {detail.data?.truncated && (
        <p className="pt-1 text-[10px] text-muted-foreground">
          {t('rename.undo.detailTruncated', { shown: ops.length, total: detail.data.total })}
        </p>
      )}
    </div>
  );
}
