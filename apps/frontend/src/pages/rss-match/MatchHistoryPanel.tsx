import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { api, type RssRuleMatchEvaluation } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { CandidateResultBadge, CheckList, ParsedDebug } from './shared';

type Tone = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'info' | 'outline';

const RESULT_TONE: Record<RssRuleMatchEvaluation['result'], Tone> = {
  matched: 'success',
  no_match: 'secondary',
  skipped_duplicate: 'warning',
};

const RESULT_LABEL: Record<RssRuleMatchEvaluation['result'], string> = {
  matched: 'Matched',
  no_match: 'No match',
  skipped_duplicate: 'Skipped (duplicate)',
};

export function MatchHistoryPanel({ ruleId }: { ruleId: string }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['rss', 'match-history', ruleId],
    queryFn: () => api.rss.matchHistory(ruleId),
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (isLoading) return <CenteredSpinner label="Loading match history…" />;
  if (isError) return <ErrorState message="Could not load match history." onRetry={() => refetch()} />;
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title="No evaluations yet"
            description="Items matched against this rule's candidates will be recorded here."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {data.map((evaluation) => {
        const open = expanded.has(evaluation.id);
        const matchedName =
          evaluation.matchedCandidateId != null
            ? evaluation.evaluationTrace.candidates.find(
                (c) => c.candidateId === evaluation.matchedCandidateId,
              )?.name ?? 'unknown candidate'
            : null;
        return (
          <Card key={evaluation.id}>
            <button
              type="button"
              onClick={() => toggle(evaluation.id)}
              className="flex w-full items-center gap-3 p-4 text-left"
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <Badge variant={RESULT_TONE[evaluation.result]} dot>
                {RESULT_LABEL[evaluation.result]}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  {matchedName ? (
                    <span className="truncate">
                      {matchedName}
                      {evaluation.matchedCandidatePriority != null && (
                        <span className="text-muted-foreground">
                          {' '}
                          (priority {evaluation.matchedCandidatePriority + 1})
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">no candidate matched</span>
                  )}
                  {evaluation.actionTaken && (
                    <Badge variant="info">{evaluation.actionTaken}</Badge>
                  )}
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTime(evaluation.createdAt)}
              </span>
            </button>

            {open && (
              <div className="space-y-3 border-t border-border/60 px-4 py-3">
                <ParsedDebug parsed={evaluation.evaluationTrace.parsed} />
                {evaluation.torrentHash && (
                  <p className="font-mono text-xs text-muted-foreground">
                    torrent: {evaluation.torrentHash}
                  </p>
                )}
                <div className="space-y-2">
                  {evaluation.evaluationTrace.candidates.map((c, i) => (
                    <div
                      key={c.candidateId}
                      className={cn(
                        'rounded-md p-2.5',
                        c.result === 'matched'
                          ? 'bg-success/10 ring-1 ring-success/30'
                          : 'bg-white/[0.02]',
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {i + 1}. {c.name}
                        </span>
                        <CandidateResultBadge result={c.result} />
                      </div>
                      {c.reason && (
                        <p className="mt-1 text-xs text-muted-foreground">{c.reason}</p>
                      )}
                      <CheckList checks={c.checks} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
