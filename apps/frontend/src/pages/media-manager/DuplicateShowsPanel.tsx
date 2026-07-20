import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderTree, TriangleAlert, ArrowRight, Trash2, Captions, Eye, Bookmark } from 'lucide-react';
import {
  ApiError,
  api,
  type DuplicateShowFamily,
  type DuplicateShowMember,
  type ShowMergePlan,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
 * ("Happy's Place (2024)" beside "Happys Place").
 *
 * The operator picks which path is the real one, sees what each folder actually
 * contributes (unique episodes, subtitles, watchlist links), resolves every
 * same-episode collision by hand if they want to, and only then confirms. What runs
 * is the plan the server stored and the operator read — the confirm sends a plan id,
 * not a list of files.
 */
export function DuplicateShowsPanel() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const qc = useQueryClient();

  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [acked, setAcked] = useState<Record<number, boolean>>({});
  const [active, setActive] = useState<{ family: DuplicateShowFamily; canonicalShowId: string; ack: boolean } | null>(
    null,
  );

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'duplicate-shows'],
    queryFn: () => api.media.duplicateShows(),
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
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{t('shows.dupes.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('shows.dupes.subtitle')}</p>
      </div>

      {families.map((family, i) => {
        const canonicalId = chosen[i] ?? family.suggestedCanonicalShowId;
        const conflict = family.reviewReason === 'metadata_conflict';
        const ack = !!acked[i];
        return (
          <Card key={i}>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <FolderTree className="h-4 w-4 text-info" />
                <span className="font-medium">{family.members[0]?.title}</span>
                <Badge variant="secondary">{t('shows.dupes.foldersCount', { count: family.members.length })}</Badge>
                <Badge variant="info">{t(`shows.dupes.reason.${family.reason === 'name+imdb' ? 'nameImdb' : family.reason}`)}</Badge>
                {family.collidingEpisodes.length > 0 && (
                  <Badge variant="secondary">
                    {t('shows.dupes.collisionsBadge', { count: family.collidingEpisodes.length })}
                  </Badge>
                )}
                {conflict && (
                  <Badge variant="destructive" className="gap-1">
                    <TriangleAlert className="h-3 w-3" /> {t('shows.dupes.conflictBadge')}
                  </Badge>
                )}
              </div>

              {conflict && (
                // The IMDb id alone tied these together and their names disagree —
                // one mis-tagged episode is enough to do that. Say so plainly, and
                // make the operator affirm it rather than click past a warning.
                <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                  <p className="text-xs text-muted-foreground">{t('shows.dupes.reviewHint')}</p>
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                    <Checkbox
                      checked={ack}
                      onCheckedChange={(v) => setAcked((a) => ({ ...a, [i]: !!v }))}
                    />
                    {t('shows.dupes.ackConflict')}
                  </label>
                </div>
              )}

              <p className="text-xs text-muted-foreground">{t('shows.dupes.pickReal')}</p>

              <ul className="divide-y divide-border/40 rounded-md border border-border/60">
                {family.members.map((m) => (
                  <li key={m.showId}>
                    <MemberRow
                      member={m}
                      name={`canonical-${i}`}
                      selected={canonicalId === m.showId}
                      recommended={m.showId === family.suggestedCanonicalShowId}
                      onSelect={() => setChosen((c) => ({ ...c, [i]: m.showId }))}
                    />
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-end gap-2">
                {conflict && !ack && (
                  <span className="text-xs text-muted-foreground">{t('shows.dupes.ackRequired')}</span>
                )}
                <Button
                  size="sm"
                  disabled={conflict && !ack}
                  onClick={() => setActive({ family, canonicalShowId: canonicalId, ack })}
                >
                  <Eye className="h-3.5 w-3.5" /> {t('shows.dupes.previewAction')}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {active && (
        <MergeDialog
          family={active.family}
          canonicalShowId={active.canonicalShowId}
          acknowledgeMetadataConflict={active.ack}
          onClose={() => setActive(null)}
          onMerged={() => {
            setActive(null);
            void qc.invalidateQueries({ queryKey: ['media'] });
          }}
          toastError={(title, detail) => toast.error(title, detail)}
          toastSuccess={(title, detail) => toast.success(title, detail)}
        />
      )}
    </div>
  );
}

/** One candidate folder, and what it actually contributes to the merge. */
function MemberRow({
  member,
  name,
  selected,
  recommended,
  onSelect,
}: {
  member: DuplicateShowMember;
  name: string;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('media');
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 px-3 py-2 text-sm hover:bg-white/[0.02]',
        selected && 'bg-primary/10',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={selected}
        onChange={onSelect}
        aria-label={member.path}
        className="mt-1"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate font-mono text-xs" title={member.path}>
          {member.path}
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>{t('shows.dupes.videos', { count: member.videoCount })}</span>
          <span>{formatBytes(member.sizeBytes)}</span>
          {/* The number that actually decides which folder to keep. */}
          <span className={cn(member.uniqueEpisodes.length > 0 && 'text-warning')}>
            {t('shows.dupes.uniqueEpisodes', { count: member.uniqueEpisodes.length })}
          </span>
          {member.sidecars.subtitles > 0 && (
            <span className="inline-flex items-center gap-1">
              <Captions className="h-3 w-3" />
              {t('shows.dupes.subtitles', { count: member.sidecars.subtitles })}
            </span>
          )}
          {member.watchlistCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Bookmark className="h-3 w-3" />
              {t('shows.dupes.watchlist', { count: member.watchlistCount })}
            </span>
          )}
          {member.year != null && <span>{member.year}</span>}
          {member.imdbId && <span className="font-mono">{member.imdbId}</span>}
        </p>
      </div>
      {recommended && (
        <Badge variant="secondary" className="shrink-0">
          {t('shows.dupes.recommended')}
        </Badge>
      )}
    </label>
  );
}

/**
 * The plan, and the one place a collision winner can be changed.
 *
 * Changing a winner rebuilds the plan on the SERVER rather than editing the
 * displayed one, so the thing the operator confirms is always a plan the server
 * produced and stored.
 */
function MergeDialog({
  family,
  canonicalShowId,
  acknowledgeMetadataConflict,
  onClose,
  onMerged,
  toastError,
  toastSuccess,
}: {
  family: DuplicateShowFamily;
  canonicalShowId: string;
  acknowledgeMetadataConflict: boolean;
  onClose: () => void;
  onMerged: () => void;
  toastError: (title: string, detail?: string) => void;
  toastSuccess: (title: string, detail?: string) => void;
}) {
  const { t } = useTranslation('media');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<ShowMergePlan | null>(null);

  const preview = useMutation({
    mutationFn: (collisionChoices: Record<string, string>) =>
      api.media.previewShowMerge({
        canonicalShowId,
        duplicateShowIds: family.members.filter((m) => m.showId !== canonicalShowId).map((m) => m.showId),
        collisionChoices,
        acknowledgeMetadataConflict,
      }),
    onSuccess: setPlan,
    onError: (e) => {
      toastError(t('shows.dupes.previewFailed'), e instanceof ApiError ? e.message : undefined);
      onClose();
    },
  });

  const merge = useMutation({
    mutationFn: () => api.media.mergeShows(plan!.planId),
    onSuccess: (r) => {
      if (r.status === 'completed') {
        toastSuccess(
          t('shows.dupes.mergedTitle'),
          t('shows.dupes.mergedBody', {
            moved: r.moved,
            trashed: r.trashed,
            rescued: r.rescued,
            deleted: r.deleted,
            size: formatBytes(r.reclaimedBytes),
          }),
        );
      } else {
        // Partial is reported as partial. A run that moved some files and failed on
        // others is a problem to see, not a success with a footnote.
        toastError(
          t('shows.dupes.partialTitle'),
          t('shows.dupes.partialBody', { moved: r.moved, skipped: r.skipped, failed: r.failed }),
        );
      }
      onMerged();
    },
    onError: (e) => toastError(t('shows.dupes.mergeFailed'), e instanceof ApiError ? e.message : undefined),
  });

  // Build the plan as the dialog opens, and again whenever a winner changes — a
  // stale plan is exactly what this workflow exists to prevent.
  useEffect(() => {
    preview.mutate(choices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices]);

  const blocked = (plan?.blockers.length ?? 0) > 0;
  const busy = preview.isPending || merge.isPending;

  return (
    <Dialog open onClose={onClose} title={t('shows.dupes.previewTitle')} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t('shows.dupes.previewTitle')}</DialogTitle>
        <DialogDescription>
          {t('shows.dupes.previewDesc', { path: plan?.canonical.path ?? '' })}
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[55vh] space-y-4 overflow-y-auto scrollbar-thin">
        {preview.isPending || !plan ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('shows.dupes.building')}</p>
        ) : (
          <>
            {blocked && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <p className="mb-1 font-medium text-destructive">{t('shows.dupes.blocked')}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {plan.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            <Section title={t('shows.dupes.collisions', { count: plan.collisions.length })}>
              {plan.collisions.map((c) => {
                const options = [
                  { path: c.existing, bytes: c.existingBytes, side: 'existing' as const },
                  { path: c.incoming, bytes: c.incomingBytes, side: 'incoming' as const },
                ];
                return (
                  <li key={c.key} className="space-y-1">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                      S{String(c.season ?? 0).padStart(2, '0')}E{String(c.episode ?? 0).padStart(2, '0')}
                      {c.chosenByOperator ? (
                        <Badge variant="info">{t('shows.dupes.yourChoice')}</Badge>
                      ) : (
                        <span className="normal-case">{t('shows.dupes.keepsLarger')}</span>
                      )}
                    </div>
                    {options.map((o) => {
                      const wins = c.winner === o.side;
                      return (
                        <label
                          key={o.path}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono text-[11px] hover:bg-white/[0.02]',
                            wins ? 'bg-success/10' : 'text-destructive',
                          )}
                        >
                          <input
                            type="radio"
                            name={`collision-${c.key}`}
                            checked={wins}
                            disabled={busy}
                            onChange={() => setChoices((prev) => ({ ...prev, [c.key]: o.path }))}
                            aria-label={o.path}
                          />
                          {!wins && <Trash2 className="h-3 w-3 shrink-0" />}
                          <span className="min-w-0 flex-1 truncate" title={o.path}>
                            {o.path}
                          </span>
                          <span className="shrink-0">{formatBytes(o.bytes)}</span>
                        </label>
                      );
                    })}
                  </li>
                );
              })}
            </Section>

            <Section title={t('shows.dupes.moves', { count: plan.moves.length })}>
              {plan.moves.map((m, i) => (
                <li key={i} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={m.from}>
                    {m.from}
                  </span>
                  <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  {m.kind !== 'video' && (
                    <Badge variant="secondary" className="shrink-0">
                      {t(`shows.dupes.moveKind.${m.kind === 'sidecar' ? 'sidecar' : 'rescued'}`)}
                    </Badge>
                  )}
                  <span className="shrink-0">{formatBytes(m.sizeBytes)}</span>
                </li>
              ))}
            </Section>

            {plan.rescuedSubtitles.length > 0 && (
              // Not a warning — a reassurance. The folder these live in is about to
              // go, and without this they would go with it.
              <div className="rounded-md border border-info/40 bg-info/5 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-info">
                  <Captions className="h-3.5 w-3.5" />
                  {t('shows.dupes.rescued', { count: plan.rescuedSubtitles.length })}
                </p>
                <p className="mb-2 text-[11px] text-muted-foreground">{t('shows.dupes.rescuedHint')}</p>
                <ul className="space-y-0.5">
                  {plan.rescuedSubtitles.map((r) => (
                    <li key={r.from} className="truncate font-mono text-[11px]" title={r.to}>
                      {r.from.split('/').pop()}
                      {r.language ? ` (${r.language})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.watchlistRepoint > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Bookmark className="h-3.5 w-3.5" />
                {t('shows.dupes.repoint', { count: plan.watchlistRepoint })}
              </p>
            )}

            <Section title={t('shows.dupes.deletions', { count: plan.deletions.length })} danger>
              {plan.deletions.map((d, i) => (
                <li key={i} className="truncate font-mono text-[11px] text-destructive" title={d}>
                  {d}
                </li>
              ))}
            </Section>

            <div className="space-y-1 text-xs text-muted-foreground">
              <p>{t('shows.dupes.reclaim', { size: formatBytes(plan.expectedFreedBytes) })}</p>
              {/* The one thing that most reduces fear of the button. */}
              <p>{t('shows.dupes.trashNote')}</p>
              <p>{t('shows.dupes.rescanNote')}</p>
            </div>
          </>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={merge.isPending}>
          {t('shows.dupes.cancel')}
        </Button>
        <Button
          variant="destructive"
          onClick={() => merge.mutate()}
          loading={merge.isPending}
          disabled={!plan || blocked || busy}
        >
          <Trash2 className="h-4 w-4" /> {t('shows.dupes.confirm')}
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
