import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ClipboardCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { RiskBadge, ReasonList } from './HouseholdShared';

const DISPOSITIONS = ['dismissed', 'trusted', 'travel', 'mobile', 'confirmed_sharing'] as const;

export function HouseholdReviewPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['household', 'reviews'], queryFn: () => api.mediaServerAnalytics.household.reviews() });

  const disp = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.mediaServerAnalytics.household.reviewDisposition(id, status),
    onSuccess: () => { toast.success(t('household.review.saved')); void qc.invalidateQueries({ queryKey: ['household'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><ClipboardCheck className="h-6 w-6" /> {t('household.review.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('household.review.subtitle')}</p>
      </div>

      {q.isLoading ? <CenteredSpinner /> : q.isError ? <ErrorState title={t('household.loadError')} onRetry={() => void q.refetch()} /> :
        (q.data ?? []).length === 0 ? <Card><CardContent className="py-12"><EmptyState title={t('household.review.empty')} description={t('household.review.emptyHint')} /></CardContent></Card> : (
        <div className="space-y-3">
          {(q.data ?? []).map((r) => (
            <Card key={r.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="font-semibold">{r.displayName ?? r.subjectKey.slice(0, 8)}</span>
                    <RiskBadge level={r.riskLevel} score={r.riskScore} />
                  </span>
                  <Link to={`/media-server-analytics/household/users/${r.profileId}`}><Button variant="ghost" size="sm">{t('household.review.openProfile')}</Button></Link>
                </div>
                <ReasonList reasons={r.reasons} />
                <div className="flex flex-wrap gap-2 pt-1">
                  {DISPOSITIONS.map((d) => (
                    <Button key={d} size="sm" variant={d === 'confirmed_sharing' ? 'destructive' : 'secondary'} disabled={disp.isPending}
                      onClick={() => disp.mutate({ id: r.id, status: d })}>
                      {t(`household.disposition.${d}`)}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
