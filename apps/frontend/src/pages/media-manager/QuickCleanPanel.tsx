import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Sparkles, Trash2 } from 'lucide-react';
import { ApiError, api, type DuplicateBulkPreview } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { duplicateReasonLabel } from './constants';

/**
 * Clean many high-confidence groups without opening each one.
 *
 * Two things keep this from being the dangerous shortcut it could be. Eligibility is
 * decided by the SERVER — this panel cannot ask for a group the engine flagged for
 * review, because the engine withholds a keeper on exactly those. And the flow is
 * still preview-then-confirm: selecting groups builds real server-side plans, the
 * operator sees the totals those plans produced, and only then confirms.
 *
 * Nothing is pre-selected. "Select all" is one click away, but the default is a
 * deliberate choice rather than a full basket the operator has to empty.
 */
export function QuickCleanPanel() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<DuplicateBulkPreview | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'duplicates', 'quick-clean'],
    queryFn: () => api.media.quickCleanCandidates(),
  });

  const preview = useMutation({
    mutationFn: () => api.media.bulkPreviewDuplicates([...selected]),
    onSuccess: setPlan,
    onError: (err) =>
      toast.error(t('duplicates.quick.previewFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const resolve = useMutation({
    mutationFn: () =>
      api.media.bulkResolveDuplicates(
        plan!.results.filter((r) => r.ok && r.resolutionId).map((r) => r.resolutionId!),
      ),
    onSuccess: (r) => {
      if (r.failed === 0) {
        toast.success(
          t('duplicates.quick.doneTitle'),
          t('duplicates.quick.doneBody', { count: r.succeeded, size: formatBytes(r.reclaimedBytes) }),
        );
      } else {
        // Partial is an error, not a success with a footnote.
        toast.error(
          t('duplicates.quick.partialTitle'),
          t('duplicates.quick.partialBody', { ok: r.succeeded, failed: r.failed }),
        );
      }
      // Selection is deliberately NOT cleared on a partial run: the operator needs to
      // see which groups are still there rather than start again from nothing.
      if (r.failed === 0) setSelected(new Set());
      setPlan(null);
      void queryClient.invalidateQueries({ queryKey: ['media', 'duplicates'] });
    },
    onError: (err) =>
      toast.error(t('duplicates.quick.failed'), err instanceof ApiError ? err.message : undefined),
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError) return <ErrorState message={t('duplicates.quick.loadError')} onRetry={() => void refetch()} />;

  const groups = data?.groups ?? [];
  if (!groups.length) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<Sparkles className="h-6 w-6" />}
            title={t('duplicates.quick.emptyTitle')}
            description={t('duplicates.quick.emptyBody')}
          />
        </CardContent>
      </Card>
    );
  }

  const toggle = (id: string) => {
    setPlan(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedGroups = groups.filter((g) => selected.has(g.id));
  const selectedSavings = selectedGroups.reduce((a, g) => a + g.potentialSavingsBytes, 0);
  const selectedFiles = selectedGroups.reduce((a, g) => a + Math.max(0, g.fileCount - 1), 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{t('duplicates.quick.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('duplicates.quick.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium">
              {t('duplicates.quick.selectedSummary', {
                groups: selectedGroups.length,
                files: selectedFiles,
                size: formatBytes(selectedSavings),
              })}
            </p>
            <p className="text-xs text-muted-foreground">{t('duplicates.cleanup.trashNote')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPlan(null);
                setSelected(selected.size === groups.length ? new Set() : new Set(groups.map((g) => g.id)));
              }}
            >
              {selected.size === groups.length ? t('duplicates.quick.selectNone') : t('duplicates.quick.selectAll')}
            </Button>
            {plan ? (
              <Button variant="destructive" loading={resolve.isPending} onClick={() => resolve.mutate()}>
                <Trash2 className="h-4 w-4" />{' '}
                {t('duplicates.quick.confirm', { count: plan.totalFiles, size: formatBytes(plan.totalSavingsBytes) })}
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={!selected.size}
                loading={preview.isPending}
                onClick={() => preview.mutate()}
              >
                {t('duplicates.quick.preview')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {plan ? (
        <Card>
          <CardContent className="space-y-2 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="h-4 w-4 text-success" />
              {t('duplicates.quick.planned', { count: plan.succeeded, files: plan.totalFiles })}
            </p>
            {plan.failed > 0 ? (
              <div className="rounded border border-warning/40 bg-warning/5 p-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t('duplicates.quick.someFailed', { count: plan.failed })}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {plan.results.filter((r) => !r.ok).map((r) => (
                    <li key={r.groupId}>{r.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-2">
        {groups.map((g) => (
          <Card key={g.id}>
            <CardContent className="flex flex-wrap items-center gap-3">
              <Checkbox
                checked={selected.has(g.id)}
                onCheckedChange={() => toggle(g.id)}
                aria-label={t('duplicates.quick.selectGroup', { title: g.title ?? g.id })}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{g.title ?? g.id}</p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="info">{duplicateReasonLabel(t, g.reason)}</Badge>
                  <span>{t('duplicates.itemsCount', { count: g.fileCount })}</span>
                  <span>{t('duplicates.quick.confidence', { value: g.confidence })}</span>
                </p>
              </div>
              <span className="text-sm tabular-nums text-muted-foreground">
                {formatBytes(g.potentialSavingsBytes)}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      {data && data.totalGroups >= data.cap ? (
        <p className="text-xs text-muted-foreground">{t('duplicates.quick.capped', { cap: data.cap })}</p>
      ) : null}
    </div>
  );
}
