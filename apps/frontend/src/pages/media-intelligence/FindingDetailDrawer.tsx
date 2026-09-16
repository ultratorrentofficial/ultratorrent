import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MediaAttentionItem, MediaRecommendation } from '@ultratorrent/shared';

import { ApiError, api } from '@/lib/api';
import { formatBytes, formatDateTime, formatRelativeTimeShort } from '@/lib/format';
import { humanizeFields } from '@/lib/humanize';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { SEVERITY_VARIANT } from './mediaIntelligenceUi';

/**
 * One finding, in full.
 *
 * The list is deliberately terse — a queue of several hundred rows cannot
 * carry each finding's evidence and history — so this is where the rest
 * lives. It reads persisted state only: opening it starts no scan, no probe
 * and no provider call.
 *
 * Two separations the panel is careful to preserve visually, because they are
 * the whole point of the Attention Center:
 *
 *   - **Evidence** is what the evaluator measured. It is never editable here,
 *     and no control in this panel changes it.
 *   - **Disposition** is what a person decided. The buttons act only on that.
 *
 * History is loaded lazily on open, following the same pattern the grouped
 * series list already uses: a queue page that eagerly fetched history for
 * every visible row would issue fifty requests nobody asked for.
 */
export function FindingDetailDrawer({
  finding,
  busy,
  onClose,
  onOpenMedia,
  onVerb,
}: {
  finding: MediaAttentionItem | null;
  busy: boolean;
  onClose: () => void;
  onOpenMedia: () => void;
  onVerb: (verb: 'acknowledge' | 'dismiss' | 'reset' | 'snooze', until?: string) => void;
}) {
  const { t } = useTranslation('mediaIntelligence');
  const queryClient = useQueryClient();
  const open = finding != null;

  const history = useQuery({
    queryKey: ['mediaIntelligence', 'attention', 'history', finding?.id],
    queryFn: () => api.mediaIntelligence.findingHistory(finding!.id),
    // Nothing is fetched until the panel is actually open.
    enabled: open,
  });

  /*
   * Recommendations load on the same terms as history: lazily, and only for
   * the one finding being read. A queue page that fetched these per row would
   * issue fifty requests nobody asked for — and this list is a READ, so
   * opening the panel still starts no indexer search.
   */
  const recommendations = useQuery({
    queryKey: ['mediaIntelligence', 'recommendations', 'finding', finding?.id],
    queryFn: () => api.mediaIntelligence.recommendationsForFinding(finding!.id),
    enabled: open,
  });

  const verify = useMutation({
    mutationFn: (id: string) => api.mediaIntelligence.verifyRecommendation(id),
    // Re-read rather than patching in place: the server decides what the
    // verification actually concluded, including `no_match` and `failed`.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['mediaIntelligence', 'recommendations'] }),
  });

  if (!finding) return null;

  /*
   * Evidence is rendered through the shared humanizer, the same one the audit
   * log and the Phase 2 findings use — raw keys like `measuredFileCount` and
   * naked byte counts reached a user once already and must not again.
   */
  const evidence = humanizeFields(finding.summary);

  return (
    <Drawer open={open} onClose={onClose} title={t('attention.drawer.title')}>
      <DrawerHeader onClose={onClose}>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{finding.title}</div>
          <h2 className="text-base font-semibold">
            {t(`finding.${finding.code}` as 'finding.EPISODES_MISSING')}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={SEVERITY_VARIANT[finding.severity as 'warning'] ?? 'outline'} dot>
              {t(`severity.${finding.severity}` as 'severity.info')}
            </Badge>
            <Badge variant="outline">
              {t(`attention.disposition.${finding.disposition}` as 'attention.disposition.unreviewed')}
            </Badge>
            {finding.escalated ? <Badge variant="info">{t('attention.escalation.badge')}</Badge> : null}
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody className="space-y-6">
        {/* Why the disposition was cleared, when it was. */}
        {finding.escalationReason ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs">
            {t(
              `attention.escalation.${finding.escalationReason}` as 'attention.escalation.severity_increased',
            )}
          </p>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('attention.drawer.evidence')}
          </h3>
          {evidence.length ? (
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-1.5 text-sm">
              {evidence.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  {/* A genuinely nested value has no flat human form; the
                      humanizer hands it back as pretty JSON rather than
                      dropping it, so render that instead of an empty cell. */}
                  <dd className={f.mono ? 'break-all font-mono text-xs' : 'break-words'}>
                    {f.value ?? <pre className="whitespace-pre-wrap text-xs">{f.json}</pre>}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t('attention.drawer.noEvidence')}</p>
          )}
        </section>

        <section className="space-y-2" data-testid="finding-recommendations">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('recommendations.heading')}
          </h3>
          {recommendations.isLoading ? (
            <CenteredSpinner label={t('recommendations.heading')} />
          ) : !recommendations.data?.length ? (
            /* Honest, and common: most findings have no remedy this system
               can actually perform, and saying so beats inventing one. */
            <p className="text-sm text-muted-foreground">{t('recommendations.none')}</p>
          ) : (
            recommendations.data.map((rec) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                busy={verify.isPending}
                onVerify={() => verify.mutate(rec.id)}
              />
            ))
          )}
        </section>

        <section className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">{t('attention.drawer.firstSeen')}</span>
          <span>{formatDateTime(finding.firstObservedAt)}</span>
          <span className="text-muted-foreground">{t('attention.drawer.lastSeen')}</span>
          <span>{formatDateTime(finding.lastObservedAt)}</span>
          {finding.snoozedUntil ? (
            <>
              <span className="text-muted-foreground">{t('attention.actions.snooze')}</span>
              <span>{t('attention.snooze.until', { when: formatDateTime(finding.snoozedUntil) })}</span>
            </>
          ) : null}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('attention.history.heading')}
          </h3>
          {history.isLoading ? (
            <CenteredSpinner label={t('attention.history.heading')} />
          ) : history.isError ? (
            <ErrorState
              title={t('attention.history.heading')}
              message={history.error instanceof ApiError ? history.error.message : undefined}
              onRetry={() => {
                void history.refetch();
              }}
            />
          ) : !history.data?.length ? (
            <p className="text-sm text-muted-foreground">{t('attention.history.empty')}</p>
          ) : (
            <ol className="space-y-2">
              {history.data.map((entry) => (
                <li key={entry.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    {t(`attention.history.${entry.event}` as 'attention.history.opened')}
                    <span className="ml-1 text-xs text-muted-foreground">
                      {/* An evaluator transition has no actor; say so rather
                          than leaving a blank where a name would go. */}
                      {entry.actorName
                        ? t('attention.history.by', { name: entry.actorName })
                        : t('attention.history.bySystem')}
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-xs text-muted-foreground"
                    title={formatDateTime(entry.at)}
                  >
                    {formatRelativeTimeShort(entry.at)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </DrawerBody>

      <DrawerFooter className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onOpenMedia}>
          {t('attention.drawer.openMedia')}
        </Button>
        <div className="flex flex-wrap gap-1">
          {finding.disposition === 'unreviewed' || finding.disposition === 'acknowledged' ? (
            <>
              {finding.disposition === 'unreviewed' ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onVerb('acknowledge')}>
                  {t('attention.actions.acknowledge')}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onVerb('dismiss')}>
                {t('attention.actions.dismiss')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onVerb('reset')}>
              {t('attention.actions.reset')}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </Drawer>
  );
}

/**
 * One proposed response.
 *
 * Says what, why, how sure, and — the part that matters most — what is still
 * unknown. A recommendation that hid its unknowns would read as a promise.
 */
function RecommendationCard({
  rec,
  busy,
  onVerify,
}: {
  rec: MediaRecommendation;
  busy: boolean;
  onVerify: () => void;
}) {
  const { t } = useTranslation('mediaIntelligence');

  /*
   * The Verify control exists ONLY where a search could mean something: a
   * quality upgrade whose availability has not been settled. Rendering it
   * anywhere else would be the dead control this phase exists to avoid, and
   * `not_required` means the target is already here — there is nothing to ask
   * an indexer about.
   */
  const verifiable =
    rec.type === 'SEARCH_FOR_QUALITY_UPGRADE' &&
    rec.verification !== 'not_required' &&
    rec.verification !== 'checking';

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {t(`recommendations.type.${rec.type}` as 'recommendations.type.SEARCH_SUBTITLES')}
        </span>
        {/* Confidence carries a word, never colour alone. */}
        <Badge variant="outline">
          {t('recommendations.confidence')}:{' '}
          {t(`recommendations.confidenceLevel.${rec.confidence}` as 'recommendations.confidenceLevel.high')}
        </Badge>
      </div>

      {rec.plan.length ? (
        <div>
          <div className="text-xs font-medium text-muted-foreground">{t('recommendations.expected')}</div>
          <ol className="ml-4 list-decimal text-xs text-muted-foreground">
            {rec.plan.map((step) => (
              <li key={step}>
                {t(`recommendations.step.${step}` as 'recommendations.step.search_indexers')}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {rec.unknowns.length ? (
        <div>
          <div className="text-xs font-medium text-muted-foreground">
            {t('recommendations.stillUnknown')}
          </div>
          <ul className="ml-4 list-disc text-xs text-muted-foreground">
            {rec.unknowns.map((u) => (
              <li key={u}>
                {t(
                  `recommendations.unknown.${u}` as 'recommendations.unknown.which_copy_should_be_kept',
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t('recommendations.availability')}:</span>
        <span>
          {t(
            `recommendations.verification.${rec.verification}` as 'recommendations.verification.not_checked',
          )}
        </span>
        {rec.verifiedAt ? (
          <span className="text-muted-foreground" title={formatDateTime(rec.verifiedAt)}>
            {formatRelativeTimeShort(rec.verifiedAt)}
          </span>
        ) : null}
      </div>

      {/* A real candidate, only ever shown when a real search found one. */}
      {rec.candidate ? (
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-1 rounded bg-muted/40 p-2 text-xs">
          <dt className="text-muted-foreground">{t('recommendations.candidate')}</dt>
          <dd className="break-words font-medium">{rec.candidate.releaseName}</dd>
          <dt className="text-muted-foreground">{t('recommendations.rung')}</dt>
          <dd>
            {rec.candidate.matchedRungName ?? rec.candidate.matchedRung ?? '—'}
          </dd>
          {rec.candidate.sizeBytes != null ? (
            <>
              <dt className="text-muted-foreground">{t('recommendations.size')}</dt>
              <dd>{formatBytes(rec.candidate.sizeBytes)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {verifiable ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={onVerify}>
          {busy ? t('recommendations.verifying') : t('recommendations.verify')}
        </Button>
      ) : null}
    </div>
  );
}
