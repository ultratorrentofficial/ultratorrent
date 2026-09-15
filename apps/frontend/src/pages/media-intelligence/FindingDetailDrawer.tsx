import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { MediaAttentionItem } from '@ultratorrent/shared';

import { ApiError, api } from '@/lib/api';
import { formatDateTime, formatRelativeTimeShort } from '@/lib/format';
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
  const open = finding != null;

  const history = useQuery({
    queryKey: ['mediaIntelligence', 'attention', 'history', finding?.id],
    queryFn: () => api.mediaIntelligence.findingHistory(finding!.id),
    // Nothing is fetched until the panel is actually open.
    enabled: open,
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
