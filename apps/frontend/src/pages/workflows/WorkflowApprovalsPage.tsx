import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, X, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

const RISK_VARIANT: Record<string, BadgeVariant> = {
  normal: 'secondary',
  elevated: 'warning',
  destructive: 'destructive',
};

/** The approval center — workflow steps paused on an approval gate, awaiting a decision. */
export function WorkflowApprovalsPage() {
  const { t } = useTranslation('workflows');
  const toast = useToast();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['workflows', 'approvals'],
    queryFn: () => api.workflows.pendingApprovals(),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });

  const respond = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) => api.workflows.respondApproval(id, decision),
    onSuccess: (_r, { decision }) => {
      toast.success(t(`approvals.${decision}`));
      void qc.invalidateQueries({ queryKey: ['workflows', 'approvals'] });
    },
    onError: () => toast.error(t('approvals.error')),
  });

  if (query.isLoading) return <CenteredSpinner label={t('approvals.title')} />;
  if (query.isError) return <ErrorState title={t('approvals.error')} onRetry={() => query.refetch()} />;

  const items = query.data ?? [];

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">{t('approvals.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('approvals.subtitle')}</p>
      </div>

      {items.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="h-8 w-8" />} title={t('approvals.empty')} description={t('approvals.emptyHint')} />
      ) : (
        <div className="space-y-2">
          {items.map((ap) => (
            <Card key={ap.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={RISK_VARIANT[ap.riskLevel ?? 'normal'] ?? 'secondary'}>
                      {t('approvals.risk')}: {ap.riskLevel ?? 'normal'}
                    </Badge>
                    {ap.requiredPermission && (
                      <span className="text-xs text-muted-foreground">{t('approvals.permission')}: <code>{ap.requiredPermission}</code></span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('approvals.requested')}: {new Date(ap.requestedAt).toLocaleString()}
                    {ap.expiresAt && <> · {t('approvals.expires')}: {new Date(ap.expiresAt).toLocaleString()}</>}
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">exec {ap.workflowExecutionId}</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" disabled={respond.isPending} onClick={() => respond.mutate({ id: ap.id, decision: 'rejected' })}>
                    <X className="mr-1 h-4 w-4" />{t('approvals.reject')}
                  </Button>
                  <Button size="sm" disabled={respond.isPending} onClick={() => respond.mutate({ id: ap.id, decision: 'approved' })}>
                    <Check className="mr-1 h-4 w-4" />{t('approvals.approve')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
