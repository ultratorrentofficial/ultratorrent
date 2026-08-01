import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Fingerprint, HelpCircle, Wand2 } from 'lucide-react';
import { ApiError, api, type MovieIdentityPlan, type MovieIdentityProposal } from '@/lib/api';
import type { BadgeVariant } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Repair movie identities the unverified lookup got wrong.
 *
 * This panel lives in the Duplicate Center because it explains the Center's worst
 * failure mode rather than adding a feature to it: a contaminated id makes the
 * engine group DIFFERENT FILMS as one duplicate, so acting on the recommendation
 * deletes a real movie while reporting reclaimed space. Detection is faithful; its
 * input is a lie. Fixing the ids is what makes those groups trustworthy again.
 *
 * Three things it deliberately does NOT do:
 *
 *  - **Never auto-runs.** The preview is one provider call per affected folder, so
 *    it is behind a button and never polled. A page that quietly fires dozens of
 *    API calls on mount is how a rate limit becomes an outage.
 *  - **Never sends a plan.** Apply posts nothing; the server re-previews and acts
 *    on its own findings. A repair for damage caused by writing a wrong id must
 *    not accept "write this id" from a client, and a plan can go stale between
 *    preview and apply anyway.
 *  - **Never sorts the ambiguous rows away.** They lead, because they are the only
 *    ones where a human might disagree with the outcome.
 */

/** The visual weight of each outcome — clears are the ones worth looking at. */
const ACTION_VARIANT: Record<MovieIdentityProposal['action'], BadgeVariant> = {
  reidentify: 'default',
  // `warning`, not `destructive`: clearing removes an ID, never a file. Dressing it
  // as destruction in a Center whose other buttons DO delete media is how an
  // operator learns to fear the safe action and skim the dangerous one.
  clear: 'warning',
  unchanged: 'secondary',
};

function idsLabel(ids: Record<string, string>): string {
  const entries = Object.entries(ids);
  if (!entries.length) return '—';
  return entries.map(([provider, id]) => `${provider}:${id}`).join('  ');
}

/**
 * Ambiguous first, then clears, then real changes, and the untouched last.
 *
 * Ordered by how much a human needs to see the row, not alphabetically: an
 * operator scanning this table is looking for "what might be wrong", and the rows
 * that need no decision belong at the bottom.
 */
const ACTION_RANK: Record<MovieIdentityProposal['action'], number> = {
  clear: 0,
  reidentify: 1,
  unchanged: 2,
};

function sortProposals(proposals: MovieIdentityProposal[]): MovieIdentityProposal[] {
  return [...proposals].sort((a, b) => {
    if (a.ambiguous !== b.ambiguous) return a.ambiguous ? -1 : 1;
    if (a.action !== b.action) return ACTION_RANK[a.action] - ACTION_RANK[b.action];
    return a.folderTitle.localeCompare(b.folderTitle);
  });
}

export function MovieIdentityRepairPanel() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  // Not `enabled: true` — the preview is network-bound and must be asked for.
  const [started, setStarted] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const preview = useQuery<MovieIdentityPlan>({
    queryKey: ['media', 'repair', 'movie-identity'],
    queryFn: () => api.media.previewMovieIdentityRepair(),
    enabled: started,
    // The answer is a snapshot of a slow, external call; re-running it is the
    // operator's decision, so it neither refetches on focus nor goes stale by itself.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const apply = useMutation({
    mutationFn: () => api.media.applyMovieIdentityRepair(),
    onSuccess: (r) => {
      toast.success(
        t('duplicates.identity.doneTitle'),
        t('duplicates.identity.doneBody', {
          reidentified: r.reidentified,
          cleared: r.cleared,
          unchanged: r.unchanged,
        }),
      );
      setConfirming(false);
      // The duplicate groups were built on these ids, so every one of them is now
      // suspect — invalidate the whole Center, not just this panel.
      void queryClient.invalidateQueries({ queryKey: ['media', 'duplicates'] });
      void queryClient.invalidateQueries({ queryKey: ['media', 'repair', 'movie-identity'] });
    },
    onError: (err) => {
      setConfirming(false);
      toast.error(
        t('duplicates.identity.failed'),
        err instanceof ApiError ? err.message : undefined,
      );
    },
  });

  if (!started) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<Fingerprint className="h-6 w-6" />}
            title={t('duplicates.identity.introTitle')}
            description={t('duplicates.identity.introBody')}
            action={
              <Button onClick={() => setStarted(true)}>
                {t('duplicates.identity.scanBtn')}
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  if (preview.isLoading) return <CenteredSpinner />;
  if (preview.isError) {
    return (
      <ErrorState
        message={t('duplicates.identity.loadError')}
        onRetry={() => void preview.refetch()}
      />
    );
  }

  const plan = preview.data;
  const proposals = sortProposals(plan?.proposals ?? []);

  if (!proposals.length) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<CheckCircle2 className="h-6 w-6" />}
            title={t('duplicates.identity.cleanTitle')}
            description={t('duplicates.identity.cleanBody')}
          />
        </CardContent>
      </Card>
    );
  }

  const changing = proposals.filter((p) => p.action !== 'unchanged');
  const clearing = proposals.filter((p) => p.action === 'clear').length;
  const ambiguous = proposals.filter((p) => p.ambiguous).length;

  return (
    <section className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold tracking-tight">
                {t('duplicates.identity.title')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('duplicates.identity.summary', {
                  ids: plan?.contaminatedIds ?? 0,
                  items: proposals.length,
                  changing: changing.length,
                })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => void preview.refetch()}
                disabled={preview.isFetching || apply.isPending}
              >
                {t('duplicates.identity.rescanBtn')}
              </Button>
              <Button
                onClick={() => setConfirming(true)}
                disabled={!changing.length || apply.isPending || preview.isFetching}
              >
                <Wand2 className="mr-2 h-4 w-4" />
                {t('duplicates.identity.applyBtn', { count: changing.length })}
              </Button>
            </div>
          </div>

          {clearing > 0 ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>{t('duplicates.identity.clearNote', { count: clearing })}</span>
            </p>
          ) : null}
          {ambiguous > 0 ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{t('duplicates.identity.ambiguousNote', { count: ambiguous })}</span>
            </p>
          ) : null}

          {confirming ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/5 p-3">
              <span className="text-sm">
                {t('duplicates.identity.confirmBody', {
                  changing: changing.length,
                  cleared: clearing,
                })}
              </span>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)} disabled={apply.isPending}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
                  {apply.isPending
                    ? t('duplicates.identity.applying')
                    : t('duplicates.identity.confirmBtn')}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('duplicates.identity.col.folder')}</TableHead>
                  <TableHead>{t('duplicates.identity.col.current')}</TableHead>
                  <TableHead>{t('duplicates.identity.col.proposed')}</TableHead>
                  <TableHead>{t('duplicates.identity.col.outcome')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proposals.map((p) => (
                  <TableRow key={p.itemId}>
                    <TableCell>
                      <div className="font-medium">
                        {p.folderTitle}
                        {p.folderYear ? ` (${p.folderYear})` : ''}
                      </div>
                      {/* The path is the evidence: the FILENAME is what the bad
                          lookup rewrote, so it usually names a different film than
                          the folder it sits in. Showing it is how an operator sees
                          that for themselves rather than taking our word. */}
                      <div className="break-all text-xs text-muted-foreground">{p.path}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {idsLabel(p.current)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {idsLabel(p.proposed)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={ACTION_VARIANT[p.action]}>
                          {t(`duplicates.identity.action.${p.action}` as 'duplicates.identity.action.clear')}
                        </Badge>
                        {p.ambiguous ? (
                          <Badge variant="outline">{t('duplicates.identity.ambiguousBadge')}</Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{p.reason}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
