import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, Loader2 } from 'lucide-react';
import { api, type DuplicateEntry, type DuplicateGroup } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * Shows being monitored more than once.
 *
 * This is a review surface, not a cleanup button. The grouping is evidence, and
 * evidence is sometimes wrong — so every group states how it was joined, every
 * entry shows what would be lost by choosing the other one, and the merge is a
 * deliberate act by a person who has read both.
 *
 * The one thing the UI must never imply is that anything is deleted. Duplicates
 * are bookkeeping; the media is not duplicated, and the losing entry is archived.
 */

function EntryCard({
  entry,
  chosen,
  recommended,
  onChoose,
}: {
  entry: DuplicateEntry;
  chosen: boolean;
  recommended: boolean;
  onChoose: () => void;
}) {
  const { t } = useTranslation('mediaDiscovery');
  const history = entry.history.acquisitions + entry.history.evaluations + entry.history.wantedEpisodes;

  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
        chosen ? 'border-primary/60 bg-primary/5' : 'border-white/10 hover:border-white/20'
      }`}
    >
      <input type="radio" className="mt-1" checked={chosen} onChange={onChoose} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">{entry.title}</span>
          {entry.year && <span className="text-xs text-muted-foreground">({entry.year})</span>}
          {recommended && (
            <span className="rounded border border-emerald-400/40 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
              {t('duplicates.recommended')}
            </span>
          )}
        </div>
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          <li>
            {entry.rule
              ? t('duplicates.entry.rule', {
                  name: entry.rule.name,
                  count: entry.rule.candidateCount,
                  origin: entry.rule.userModifiedAt
                    ? t('duplicates.origin.edited')
                    : entry.rule.generatedByDiscovery
                      ? t('duplicates.origin.generated')
                      : t('duplicates.origin.manual'),
                })
              : t('duplicates.entry.noRule')}
          </li>
          <li>
            {history > 0 ? t('duplicates.entry.history', { count: history }) : t('duplicates.entry.noHistory')}
          </li>
          <li>
            {Object.keys(entry.externalIds).length
              ? Object.entries(entry.externalIds)
                  .map(([ns, v]) => `${ns.toUpperCase()} ${v}`)
                  .join(' · ')
              : t('duplicates.entry.noIds')}
          </li>
        </ul>
      </div>
    </label>
  );
}

function GroupCard({ group }: { group: DuplicateGroup }) {
  const { t } = useTranslation('mediaDiscovery');
  const toast = useToast();
  const qc = useQueryClient();
  const [keepId, setKeepId] = useState(group.recommendedKeepId);

  const archiveIds = group.entries.filter((e) => e.id !== keepId).map((e) => e.id);

  // The plan is re-read whenever the choice changes: what a merge costs depends
  // entirely on which entry survives.
  const plan = useQuery({
    queryKey: ['discovery', 'duplicate-plan', group.key, keepId],
    queryFn: () => api.mediaDiscovery.duplicatePlan({ keepId, archiveIds }),
    enabled: archiveIds.length > 0,
  });

  const merge = useMutation({
    mutationFn: () => api.mediaDiscovery.mergeDuplicates({ keepId, archiveIds }),
    onSuccess: (result) => {
      toast.success(t('duplicates.merged', { title: result.keep.title, count: result.archive.length }));
      qc.invalidateQueries({ queryKey: ['discovery'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">
            {group.canonicalTitle}
            {group.year ? ` (${group.year})` : ''}
          </h3>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              group.evidence === 'external_id'
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                : 'border-amber-400/40 bg-amber-400/10 text-amber-300'
            }`}
          >
            {group.evidence === 'external_id'
              ? t('duplicates.evidence.id', { ns: group.matchedIdNamespace?.toUpperCase() ?? '' })
              : t('duplicates.evidence.title')}
          </span>
        </div>

        <p className="text-xs text-muted-foreground">{t('duplicates.chooseKeeper')}</p>

        <div className="space-y-2">
          {group.entries.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              chosen={e.id === keepId}
              recommended={e.id === group.recommendedKeepId}
              onChoose={() => setKeepId(e.id)}
            />
          ))}
        </div>

        {plan.data && (
          <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs">
            <p className="font-medium">{t('duplicates.whatHappens')}</p>
            <ul className="space-y-0.5 text-muted-foreground">
              <li>{t('duplicates.plan.archive', { count: plan.data.archive.length })}</li>
              {Object.keys(plan.data.idsGained).length > 0 && (
                <li>
                  {t('duplicates.plan.idsGained', {
                    ids: Object.entries(plan.data.idsGained)
                      .map(([ns, v]) => `${ns.toUpperCase()} ${v}`)
                      .join(', '),
                  })}
                </li>
              )}
              {plan.data.rulesDeleted.map((r) => (
                <li key={r.id}>{t('duplicates.plan.ruleDeleted', { name: r.name })}</li>
              ))}
              {plan.data.rulesKept.map((r) => (
                <li key={r.id}>{t('duplicates.plan.ruleKept', { name: r.name, reason: r.reason })}</li>
              ))}
              <li className="text-emerald-300/80">{t('duplicates.plan.neverTouched')}</li>
            </ul>
            {plan.data.warnings.map((w) => (
              <p key={w} className="flex items-start gap-1.5 text-amber-300">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {w}
              </p>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={() => merge.mutate()} disabled={merge.isPending || !archiveIds.length}>
            {merge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
            {t('duplicates.merge')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function DuplicatesPanel() {
  const { t } = useTranslation('mediaDiscovery');
  const groups = useQuery({
    queryKey: ['discovery', 'duplicates'],
    queryFn: () => api.mediaDiscovery.duplicates(),
  });

  if (groups.isLoading) return <CenteredSpinner />;
  if (groups.isError) return <ErrorState title={t('duplicates.error')} />;
  if (!groups.data?.length) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="h-6 w-6" />}
        title={t('duplicates.emptyTitle')}
        description={t('duplicates.emptyDescription')}
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('duplicates.intro', { count: groups.data.length })}</p>
      {groups.data.map((g) => (
        <GroupCard key={g.key} group={g} />
      ))}
    </div>
  );
}
