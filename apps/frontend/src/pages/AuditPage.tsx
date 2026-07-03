import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import { api, type AuditEntry } from '@/lib/api';
import { describeAudit, toneChipClasses } from '@/lib/audit';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

export function AuditPage() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['audit', page],
    queryFn: () => api.audit.list({ page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          A chronological, human-readable record of actions across the platform.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <CenteredSpinner label="Loading audit log…" />
          ) : isError ? (
            <ErrorState message="Could not load the audit log." onRetry={() => refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ScrollText className="h-6 w-6" />}
              title="No audit entries"
              description="Actions performed in UltraTorrent will be recorded here."
            />
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
            {isFetching && <span className="ml-2 opacity-70">updating…</span>}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const d = describeAudit(entry);
  const Icon = d.Icon;
  const actor = entry.user?.username ?? 'system';
  const hasDetails = !!entry.metadata || !!entry.objectId || !!entry.userAgent;

  return (
    <li className={cn(d.tone === 'destructive' && 'bg-red-500/[0.03]')}>
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
          hasDetails ? 'hover:bg-white/[0.03]' : 'cursor-default',
        )}
      >
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1',
            toneChipClasses(d.tone),
          )}
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{d.title}</span>
            <Badge variant="outline" className="text-[10px]">
              {d.category}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={d.detail ?? ''}>
            <span className="font-medium text-foreground/70">{actor}</span>
            {d.detail && <> · {d.detail}</>}
            {entry.ipAddress && <> · {entry.ipAddress}</>}
            <span className="ml-1 font-mono opacity-50"> · {entry.action}</span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            className="text-xs tabular-nums text-muted-foreground"
            title={formatDateTime(entry.createdAt)}
          >
            {formatRelativeTime(entry.createdAt)}
          </span>
          {hasDetails && (
            <ChevronDown
              className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')}
            />
          )}
        </div>
      </button>

      {open && hasDetails && (
        <div className="space-y-2 border-t border-border/40 bg-black/20 px-4 py-3 pl-[3.75rem] text-xs">
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
            {entry.objectType && (
              <>
                <dt className="text-muted-foreground">Target type</dt>
                <dd className="font-mono">{entry.objectType}</dd>
              </>
            )}
            {entry.objectId && (
              <>
                <dt className="text-muted-foreground">Target</dt>
                <dd className="break-all font-mono">{entry.objectId}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Result</dt>
            <dd>
              <Badge variant={entry.result === 'failure' ? 'destructive' : 'success'} className="text-[10px]">
                {entry.result}
              </Badge>
            </dd>
            <dt className="text-muted-foreground">When</dt>
            <dd className="tabular-nums">{formatDateTime(entry.createdAt)}</dd>
            {entry.userAgent && (
              <>
                <dt className="text-muted-foreground">User agent</dt>
                <dd className="break-all text-muted-foreground">{entry.userAgent}</dd>
              </>
            )}
          </dl>
          {entry.metadata && Object.keys(entry.metadata).length > 0 && (
            <div>
              <p className="mb-1 text-muted-foreground">Metadata</p>
              <pre className="overflow-x-auto rounded-md bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-foreground/80">
                {JSON.stringify(entry.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
