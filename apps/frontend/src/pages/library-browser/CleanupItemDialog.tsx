import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/input';

/**
 * Run a cleanup policy against the selected items.
 *
 * Cleanup is policy-driven by design — there is no "clean up this file"
 * primitive, and inventing one here would mean a deletion path that skipped the
 * exclusion rules, the reason snapshot and the plan/approve flow that the
 * Cleanup Center exists to enforce. So the dialog asks *which policy*, and the
 * run is the ordinary discovery pass narrowed to these items.
 *
 * Only **published** policies are offered: a real run pins an immutable
 * published version, so listing a draft would produce a 400 from a control that
 * looked available. When none qualify the dialog says so and points at the
 * Cleanup Center rather than showing an empty picker.
 *
 * The run produces **candidates**, not deletions. The result is reported in
 * those terms — an operator who reads "cleaned up" and finds files still there
 * has been told the wrong thing.
 */
export function CleanupItemDialog({
  open,
  count,
  itemIds,
  onClose,
}: {
  open: boolean;
  count: number;
  itemIds: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation('actions');
  const [policyId, setPolicyId] = useState('');

  const policies = useQuery({
    queryKey: ['cleanup', 'policies', 'runnable'],
    queryFn: () => api.cleanup.listPolicies({ pageSize: '100' } as never),
    enabled: open,
  });

  // A real run pins an immutable PUBLISHED version, so a draft-only policy
  // would 400 from a control that looked available.
  const runnable = (policies.data?.items ?? []).filter((p) => !!p.publishedVersionId);

  // Preselect when there is only one sensible answer, so the common case is one
  // click rather than a picker with a single option.
  useEffect(() => {
    if (runnable.length === 1) setPolicyId(runnable[0].id);
  }, [runnable.length]);

  const run = useMutation({
    mutationFn: () => api.cleanup.runPolicyOnItems(policyId, itemIds),
  });

  const close = () => {
    run.reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={t('cleanup.title')}>
      <DialogDescription>{t('cleanup.body', { count })}</DialogDescription>

      {run.isSuccess ? (
        <div className="space-y-1 py-2 text-sm">
          <p className="text-foreground">
            {t('cleanup.result', {
              matched: run.data.candidatesMatched,
              evaluated: run.data.itemsEvaluated,
            })}
          </p>
          {/* Candidates are not deletions; the plan/approve flow still applies. */}
          <p className="text-xs text-muted-foreground">{t('cleanup.resultNote')}</p>
          <Link to="/media/cleanup/runs" className="text-xs text-primary underline">
            {t('cleanup.viewRuns')}
          </Link>
        </div>
      ) : (
        <div className="space-y-1.5 py-2">
          <Label htmlFor="cleanup-policy">{t('cleanup.policy')}</Label>
          <select
            id="cleanup-policy"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={policyId}
            onChange={(e) => setPolicyId(e.target.value)}
          >
            <option value="">{t('cleanup.choose')}</option>
            {runnable.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {policies.isSuccess && runnable.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('cleanup.noPolicies')}{' '}
              <Link to="/media/cleanup/policies" className="text-primary underline">
                {t('cleanup.managePolicies')}
              </Link>
            </p>
          )}
          {run.isError && (
            <p className="text-xs text-destructive">
              {run.error instanceof ApiError ? run.error.message : t('result.failed')}
            </p>
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          {run.isSuccess ? t('confirm.close') : t('confirm.cancel')}
        </Button>
        {!run.isSuccess && (
          <Button disabled={!policyId || run.isPending} onClick={() => run.mutate()}>
            {t('cleanup.submit')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
