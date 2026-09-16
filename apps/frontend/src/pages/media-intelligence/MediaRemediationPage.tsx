import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Check, Clock } from 'lucide-react';
import {
  PERMISSIONS,
  type MediaRemediationPlan,
  type MediaRemediationPlanStep,
  type MediaRemediationSummary,
  type RemediationPlanStatus,
  type RemediationRiskClass,
  type RemediationStepStatus,
} from '@ultratorrent/shared';

import { ApiError, api } from '@/lib/api';
import { usePermission } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { ConfirmDialog } from '@/pages/cleanup/ConfirmDialog';
import { formatDateTime, formatRelativeTimeShort } from '@/lib/format';

/**
 * The Remediation Center — what UltraTorrent proposes to do, and why.
 *
 * Three things this page is careful about, each answering a way an
 * automation surface usually goes wrong.
 *
 * **It never implies the system acts on its own.** There is no automatic
 * mode to display, so nothing here hints at one. Every plan sits until a
 * person decides, and the advisory line says so rather than leaving it to be
 * inferred from an absent toggle.
 *
 * **It does not re-derive safety in the browser.** Whether a blocker can be
 * cleared by approving is computed on the server and arrives as
 * `blockSurvivesApproval`. Working that out here from `blockReason` would
 * eventually disagree with the server and offer an Approve button that 422s.
 *
 * **It distinguishes "done" from "we asked".** A plan reaches `verifying`
 * when its steps finish and only becomes `succeeded` once source truth says
 * the drift is gone, so the timeline shows that step explicitly instead of
 * collapsing it into success.
 */

const PAGE_SIZE = 25;

/** The filters an operator actually asks for, mapped to server statuses. */
const VIEWS = {
  all: undefined,
  awaiting: 'proposed',
  blocked: 'blocked',
  failed: 'failed',
  done: 'succeeded',
} as const;
type ViewKey = keyof typeof VIEWS;

const STATUS_VARIANT: Record<RemediationPlanStatus, BadgeVariant> = {
  proposed: 'info',
  awaiting_approval: 'info',
  approved: 'secondary',
  executing: 'default',
  waiting: 'secondary',
  verifying: 'secondary',
  succeeded: 'success',
  failed: 'destructive',
  blocked: 'warning',
  cancelled: 'outline',
  superseded: 'outline',
};

const STEP_VARIANT: Record<RemediationStepStatus, BadgeVariant> = {
  pending: 'outline',
  running: 'default',
  waiting: 'secondary',
  succeeded: 'success',
  failed: 'destructive',
  skipped: 'outline',
  cancelled: 'outline',
};

/** Risk is shown only when it is worth a second look. */
const RISK_VARIANT: Record<RemediationRiskClass, BadgeVariant> = {
  low: 'outline',
  moderate: 'info',
  destructive: 'warning',
  irreversible: 'destructive',
};

export function MediaRemediationPage() {
  const { t } = useTranslation('mediaIntelligence');
  const toast = useToast();
  const queryClient = useQueryClient();

  const canApprove = usePermission(PERMISSIONS.MEDIA_REMEDIATION_APPROVE);
  const canCancel = usePermission(PERMISSIONS.MEDIA_REMEDIATION_CANCEL);

  const [view, setView] = useState<ViewKey>('all');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<MediaRemediationPlan | null>(null);
  const [confirm, setConfirm] = useState<{ plan: MediaRemediationPlan; act: 'approve' | 'cancel' } | null>(
    null,
  );

  const summary = useQuery({
    queryKey: ['mediaIntelligence', 'remediation', 'summary'],
    queryFn: () => api.mediaIntelligence.remediationSummary(),
  });

  const plans = useQuery({
    queryKey: ['mediaIntelligence', 'remediation', view, page],
    queryFn: () =>
      api.mediaIntelligence.remediationPlans({
        status: VIEWS[view],
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['mediaIntelligence', 'remediation'] });

  const approve = useMutation({
    mutationFn: (id: string) => api.mediaIntelligence.approveRemediationPlan(id),
    onSuccess: () => {
      setConfirm(null);
      setOpen(null);
      invalidate();
    },
    onError: (e) =>
      toast.error(t('remediation.approveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.mediaIntelligence.cancelRemediationPlan(id, reason),
    onSuccess: () => {
      setConfirm(null);
      setOpen(null);
      invalidate();
    },
    onError: (e) =>
      toast.error(t('remediation.cancelFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (plans.isLoading) return <CenteredSpinner label={t('remediation.title')} />;
  if (plans.isError) {
    return (
      <ErrorState
        title={t('remediation.title')}
        message={plans.error instanceof ApiError ? plans.error.message : undefined}
        onRetry={() => void plans.refetch()}
      />
    );
  }

  const items = plans.data?.items ?? [];
  const total = plans.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('remediation.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('remediation.subtitle')}</p>
      </div>

      {/* Stated plainly, not left to be inferred from an absent toggle. */}
      <p className="text-xs text-muted-foreground">{t('remediation.advisory')}</p>

      {summary.data ? <SummaryTiles summary={summary.data} /> : null}

      <Tabs
        value={view}
        onValueChange={(v) => {
          setView(v as ViewKey);
          setPage(1);
        }}
      >
        <TabsList>
          {(Object.keys(VIEWS) as ViewKey[]).map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`remediation.filters.${key}` as 'remediation.filters.all')}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="py-4">
          {items.length === 0 ? (
            <EmptyState title={t('remediation.empty')} description={t('remediation.emptyHint')} />
          ) : (
            <div data-testid="remediation-rows" className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('remediation.columns.title')}</TableHead>
                    <TableHead>{t('remediation.columns.intent')}</TableHead>
                    <TableHead>{t('remediation.columns.status')}</TableHead>
                    <TableHead>{t('remediation.columns.risk')}</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((plan) => (
                    <PlanRow
                      key={plan.id}
                      plan={plan}
                      onOpen={() => setOpen(plan)}
                      onApprove={canApprove ? () => setConfirm({ plan, act: 'approve' }) : undefined}
                      onCancel={canCancel ? () => setConfirm({ plan, act: 'cancel' }) : undefined}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
        </CardContent>
      </Card>

      {open ? <PlanDetail plan={open} onClose={() => setOpen(null)} /> : null}

      {confirm ? (
        <ConfirmDialog
          open
          title={t(confirm.act === 'approve' ? 'remediation.confirmApprove' : 'remediation.confirmCancel')}
          body={
            confirm.act === 'approve'
              ? t('remediation.confirmApproveBody', {
                  domain: confirm.plan.steps[0]?.ownerDomain ?? '—',
                })
              : t('remediation.confirmCancelBody')
          }
          confirmLabel={t(confirm.act === 'approve' ? 'remediation.approve' : 'remediation.cancel')}
          destructive={confirm.act === 'cancel'}
          busy={approve.isPending || cancel.isPending}
          onConfirm={({ reason }) =>
            confirm.act === 'approve'
              ? approve.mutate(confirm.plan.id)
              : cancel.mutate({ id: confirm.plan.id, reason: reason || undefined })
          }
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Counts across the whole queue, not just this page.
 *
 * Typed as the real DTO rather than `Record<string, number>`: a renamed
 * summary field should be a compile error here, not a tile that silently
 * reads zero.
 */
function SummaryTiles({ summary }: { summary: MediaRemediationSummary }) {
  const { t } = useTranslation('mediaIntelligence');
  const keys = [
    'awaitingApproval',
    'approved',
    'executing',
    'waiting',
    'blocked',
    'failed',
    'recentlySucceeded',
  ] as const satisfies readonly (keyof MediaRemediationSummary)[];

  return (
    <div data-testid="remediation-summary" className="flex flex-wrap gap-3">
      {keys.map((key) => (
        <Card key={key} className="min-w-[8rem] flex-1">
          <CardContent className="py-3">
            <div className="text-2xl font-semibold tabular-nums">{summary[key] ?? 0}</div>
            <div className="text-xs text-muted-foreground">
              {t(`remediation.summary.${key}` as 'remediation.summary.blocked')}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function PlanRow({
  plan,
  onOpen,
  onApprove,
  onCancel,
}: {
  plan: MediaRemediationPlan;
  onOpen: () => void;
  onApprove?: () => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation('mediaIntelligence');
  const intent = (plan.explanation as { intent?: string } | null)?.intent ?? null;

  /*
   * The server decided this. A blocker it says survives approval is one no
   * signature clears, so the button must not exist — offering one would
   * promise something the API will refuse with a 422.
   */
  const approvable = onApprove && !plan.blockSurvivesApproval && APPROVABLE.has(plan.status);
  const stoppable = onCancel && !TERMINAL.has(plan.status);

  return (
    <TableRow>
      <TableCell className="font-medium">
        <button type="button" className="text-left hover:underline" onClick={onOpen}>
          {plan.title ?? plan.entityId}
        </button>
        {plan.year ? <span className="ml-1 text-muted-foreground">({plan.year})</span> : null}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {intent ? t(`remediation.intent.${intent}` as 'remediation.intent.metadata_provider_present') : plan.type}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <Badge variant={STATUS_VARIANT[plan.status]} dot>
            {t(`remediation.status.${plan.status}` as 'remediation.status.proposed')}
          </Badge>
          {plan.blockReason ? (
            <span className="text-xs text-muted-foreground">
              {t('remediation.blocked', {
                reason: t(
                  `remediation.blockReason.${plan.blockReason}` as 'remediation.blockReason.item_locked',
                ),
              })}
            </span>
          ) : null}
          {plan.approvalInvalidated ? (
            <span className="text-xs text-warning">{t('remediation.reapprovalRequired')}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        {plan.riskClass === 'low' ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <Badge variant={RISK_VARIANT[plan.riskClass]}>
            {t(`remediation.risk.${plan.riskClass}` as 'remediation.risk.low')}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {approvable ? (
            <Button size="sm" variant="ghost" onClick={onApprove}>
              <Check className="mr-1 h-4 w-4" />
              {t('remediation.approve')}
            </Button>
          ) : null}
          {stoppable ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              <Ban className="h-4 w-4" />
              <span className="sr-only">{t('remediation.cancel')}</span>
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Statuses a plan can still be approved from. Mirrors the server's gate. */
const APPROVABLE = new Set<RemediationPlanStatus>(['proposed', 'awaiting_approval']);
const TERMINAL = new Set<RemediationPlanStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
]);

/**
 * One plan, explained.
 *
 * Renders the actual steps rather than a fixed illustration: what will run,
 * which domain owns it, and which permission that domain enforces — so an
 * operator can see that approving does not hand anyone new authority.
 */
function PlanDetail({ plan, onClose }: { plan: MediaRemediationPlan; onClose: () => void }) {
  const { t } = useTranslation('mediaIntelligence');

  return (
    <Card data-testid="remediation-detail">
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{plan.title ?? plan.entityId}</h2>
            <p className="text-xs text-muted-foreground">{t('remediation.why')}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            ✕
          </Button>
        </div>

        <ul className="space-y-1 text-xs text-muted-foreground">
          {plan.policyName ? <li>{t('remediation.whyPolicy', { policy: plan.policyName })}</li> : null}
          {plan.findingCode ? <li>{t('remediation.whyFinding', { code: plan.findingCode })}</li> : null}
          {plan.expiresAt ? (
            <li>{t('remediation.expiresAt', { when: formatRelativeTimeShort(plan.expiresAt) })}</li>
          ) : null}
          {plan.approvedAt ? (
            <li>{t('remediation.approvedBy', { when: formatDateTime(plan.approvedAt) })}</li>
          ) : null}
        </ul>

        {plan.blockReason ? (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-warning">
              <AlertTriangle className="h-4 w-4" />
              {t('remediation.blocked', {
                reason: t(
                  `remediation.blockReason.${plan.blockReason}` as 'remediation.blockReason.item_locked',
                ),
              })}
            </div>
            {/*
              * The distinction the whole phase rests on: some refusals are
              * "nobody has said yes yet", and some are "the system does not
              * know enough". Only the second survives a signature.
              */}
            {plan.blockSurvivesApproval ? (
              <p className="mt-1 text-muted-foreground">{t('remediation.blockedUnknowable')}</p>
            ) : null}
          </div>
        ) : null}

        {plan.status === 'verifying' ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-4 w-4" />
            {t('remediation.waitingForResult')}
          </p>
        ) : null}

        <div>
          <h3 className="mb-2 text-sm font-medium">{t('remediation.steps')}</h3>
          <ol data-testid="remediation-steps" className="space-y-2">
            {plan.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ol>
        </div>

        {plan.failureClass ? (
          <p className="text-xs text-destructive">
            {t(
              `remediation.failureClass.${plan.failureClass}` as 'remediation.failureClass.permanent',
            )}
            {plan.failureMessage ? `: ${plan.failureMessage}` : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StepRow({ step }: { step: MediaRemediationPlanStep }) {
  const { t } = useTranslation('mediaIntelligence');

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
      <Badge variant={STEP_VARIANT[step.status]} dot>
        {t(`remediation.stepStatus.${step.status}` as 'remediation.stepStatus.pending')}
      </Badge>
      <span className="text-sm font-medium">
        {t(`remediation.kind.${step.kind}` as 'remediation.kind.refresh_metadata')}
      </span>
      <span className="text-xs text-muted-foreground">
        {t('remediation.stepOwner', { domain: step.ownerDomain })}
      </span>
      {/*
        * Shown so it is visible that the OWNING domain's permission still
        * applies. Approving a plan authorises the plan, not the mutation.
        */}
      {step.requiredPermission ? (
        <span className="ml-auto text-xs text-muted-foreground">
          {t('remediation.stepPermission', { permission: step.requiredPermission })}
        </span>
      ) : null}
    </li>
  );
}
