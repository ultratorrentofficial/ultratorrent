import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

export function LiveActivityPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const q = useQuery({
    queryKey: ['mediaServerAnalytics', 'live'],
    queryFn: () => api.mediaServerAnalytics.live(),
    refetchInterval: 15000,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('liveActivity.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('liveActivity.subtitle')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={q.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {t('liveActivity.refresh')}
        </Button>
      </div>

      {q.isLoading ? (
        <CenteredSpinner />
      ) : q.isError ? (
        <ErrorState title={t('liveActivity.loadError')} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.length === 0 ? (
        <EmptyState title={t('liveActivity.empty')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {q.data.map((s) => (
            <Card key={s.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                  {s.playbackState && <Badge variant={s.playbackState === 'paused' ? 'secondary' : 'success'}>{s.playbackState}</Badge>}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {s.userName && <span>{s.userName}</span>}
                  {s.libraryName && <span>· {s.libraryName}</span>}
                  {s.device && <span>· {s.device}</span>}
                  {s.playbackMethod && <span>· {s.playbackMethod}</span>}
                  {s.resolution && <span>· {s.resolution}</span>}
                </div>
                {s.progressPercent != null && <Progress value={s.progressPercent / 100} />}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
