import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderTree, TriangleAlert, ArrowRight, Trash2 } from 'lucide-react';
import {
  ApiError,
  api,
  type DuplicateShowFamily,
  type ShowMergePlan,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

/**
 * Duplicate SHOW FOLDERS — two directories that are really one show
 * ("Happy's Place (2024)" beside "Happys Place"). The operator picks which path is
 * the real one; nothing is merged until they see the exact plan and confirm.
 */
export function DuplicateShowsPanel() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const qc = useQueryClient();

  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [plan, setPlan] = useState<{ family: DuplicateShowFamily; plan: ShowMergePlan } | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'duplicate-shows'],
    queryFn: () => api.media.duplicateShows(),
  });

  const preview = useMutation({
    mutationFn: ({ family, canonicalShowId }: { family: DuplicateShowFamily; canonicalShowId: string }) =>
      api.media
        .previewShowMerge(
          canonicalShowId,
          family.members.filter((m) => m.showId !== canonicalShowId).map((m) => m.showId),
        )
        .then((p) => ({ family, plan: p })),
    onSuccess: setPlan,
    onError: (e) => toast.error(t('shows.dupes.previewFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const merge = useMutation({
    mutationFn: (p: ShowMergePlan) =>
      api.media.mergeShows(
        p.canonical.showId,
        p.duplicates.map((d) => d.showId),
      ),
    onSuccess: (r) => {
      toast.success(
        t('shows.dupes.merged', { moved: r.moved, trashed: r.trashed, deleted: r.deleted }),
      );
      setPlan(null);
      void qc.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (e) => toast.error(t('shows.dupes.mergeFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (isLoading) return <CenteredSpinner label={t('shows.dupes.loading')} />;
  if (isError) return <ErrorState message={t('shows.dupes.loadError')} onRetry={() => void refetch()} />;

  const families = data ?? [];
  if (families.length === 0) {
    return (
      <EmptyState
        icon={<FolderTree className="h-6 w-6" />}
        title={t('shows.dupes.emptyTitle')}
        description={t('shows.dupes.emptyHint')}
      />
    );
  }

  return (
    <div className="space-y-4">
      {families.map((family, i) => {
        const canonicalId = chosen[i] ?? family.suggestedCanonicalShowId;
        return (
          <Card key={i}>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <FolderTree className="h-4 w-4 text-info" />
                <span className="font-medium">{family.members[0]?.title}</span>
                <Badge variant="secondary">{t('shows.dupes.foldersCount', { count: family.members.length })}</Badge>
                {family.needsReview && (
                  <Badge variant="destructive" className="gap-1">
                    <TriangleAlert className="h-3 w-3" /> {t('shows.dupes.reviewBadge')}
                  </Badge>
                )}
              </div>

              {family.needsReview && (
                // The IMDb id alone tied these together and their names disagree —
                // one mis-tagged episode is enough to do that. Say so plainly.
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
                  {t('shows.dupes.reviewHint')}
                </p>
              )}

              <p className="text-xs text-muted-foreground">{t('shows.dupes.pickReal')}</p>

              <ul className="divide-y divide-border/40 rounded-md border border-border/60">
                {family.members.map((m) => (
                  <li key={m.showId}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-white/[0.02]',
                        canonicalId === m.showId && 'bg-primary/10',
                      )}
                    >
                      <input
                        type="radio"
                        name={`canonical-${i}`}
                        checked={canonicalId === m.showId}
                        onChange={() => setChosen((c) => ({ ...c, [i]: m.showId }))}
                        aria-label={m.path}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={m.path}>
                        {m.path}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('shows.dupes.videos', { count: m.videoCount })} · {formatBytes(m.sizeBytes)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  loading={preview.isPending}
                  onClick={() => preview.mutate({ family, canonicalShowId: canonicalId })}
                >
                  {t('shows.dupes.previewAction')}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <MergePreviewDialog
        state={plan}
        onClose={() => setPlan(null)}
        onConfirm={() => plan && merge.mutate(plan.plan)}
        busy={merge.isPending}
      />
    </div>
  );
}

/** Exactly what will move, what will be trashed, and what will be deleted. */
function MergePreviewDialog({
  state,
  onClose,
  onConfirm,
  busy,
}: {
  state: { family: DuplicateShowFamily; plan: ShowMergePlan } | null;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation('media');
  if (!state) return null;
  const { plan } = state;
  const blocked = plan.blockers.length > 0;

  return (
    <Dialog open onClose={onClose} title={t('shows.dupes.previewTitle')} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t('shows.dupes.previewTitle')}</DialogTitle>
        <DialogDescription>
          {t('shows.dupes.previewDesc', { path: plan.canonical.path })}
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[55vh] space-y-4 overflow-y-auto scrollbar-thin">
        {blocked && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="mb-1 font-medium text-destructive">{t('shows.dupes.blocked')}</p>
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {plan.blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        <Section title={t('shows.dupes.moves', { count: plan.moves.length })}>
          {plan.moves.map((m, i) => (
            <li key={i} className="flex items-center gap-2 font-mono text-[11px]">
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={m.from}>{m.from}</span>
              <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              <span className="shrink-0">{formatBytes(m.sizeBytes)}</span>
            </li>
          ))}
        </Section>

        <Section title={t('shows.dupes.collisions', { count: plan.collisions.length })}>
          {plan.collisions.map((c, i) => (
            <li key={i} className="space-y-0.5 font-mono text-[11px]">
              <div className="text-muted-foreground">
                S{String(c.season ?? 0).padStart(2, '0')}E{String(c.episode ?? 0).padStart(2, '0')} —{' '}
                {t('shows.dupes.keepsLarger')}
              </div>
              <div className="pl-3">
                ✓ {formatBytes(Math.max(c.incomingBytes, c.existingBytes))}{' '}
                {c.winner === 'incoming' ? c.incoming : c.existing}
              </div>
              <div className="pl-3 text-destructive">
                <Trash2 className="mr-1 inline h-3 w-3" />
                {formatBytes(Math.min(c.incomingBytes, c.existingBytes))} {c.trashed}
              </div>
            </li>
          ))}
        </Section>

        <Section title={t('shows.dupes.deletions', { count: plan.deletions.length })} danger>
          {plan.deletions.map((d, i) => (
            <li key={i} className="truncate font-mono text-[11px] text-destructive" title={d}>
              {d}
            </li>
          ))}
        </Section>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('shows.dupes.cancel')}
        </Button>
        <Button variant="destructive" onClick={onConfirm} loading={busy} disabled={blocked}>
          {t('shows.dupes.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function Section({
  title,
  danger,
  children,
}: {
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div>
      <p
        className={cn(
          'mb-1 text-[11px] uppercase tracking-wide',
          danger ? 'text-destructive/80' : 'text-muted-foreground/70',
        )}
      >
        {title}
      </p>
      {hasRows ? (
        <ul className="space-y-1 rounded-md border border-border/60 p-2">{children}</ul>
      ) : (
        <p className="rounded-md border border-border/60 p-2 text-xs text-muted-foreground">—</p>
      )}
    </div>
  );
}
