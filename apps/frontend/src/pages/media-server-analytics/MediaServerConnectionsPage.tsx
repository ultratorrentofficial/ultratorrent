import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Library } from 'lucide-react';
import { api, ApiError, type MediaServerLibrariesResult } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  online: 'success',
  offline: 'destructive',
  unknown: 'secondary',
};

export function MediaServerConnectionsPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [libraries, setLibraries] = useState<{ name: string; result: MediaServerLibrariesResult } | null>(null);

  const q = useQuery({ queryKey: ['mediaServerAnalytics', 'dashboard'], queryFn: () => api.mediaServerAnalytics.dashboard() });

  const test = useMutation({
    mutationFn: (id: string) => api.mediaServerAnalytics.testConnection(id),
    onSuccess: (info) => {
      toast.success(t('connections.tested'), `${info.reachable ? 'online' : 'offline'} · ${info.version ?? '—'}`);
      void queryClient.invalidateQueries({ queryKey: ['mediaServerAnalytics', 'dashboard'] });
    },
    onError: (err) => toast.error(t('connections.testFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const showLibraries = useMutation({
    mutationFn: (id: string) => api.mediaServerAnalytics.libraries(id),
    onError: (err) => toast.error(t('connections.librariesFailed'), err instanceof ApiError ? err.message : undefined),
  });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError || !q.data) return <ErrorState title={t('connections.loadError')} onRetry={() => void q.refetch()} />;

  const connections = q.data.connections;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('connections.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('connections.subtitle')}</p>
      </div>

      {connections.length === 0 ? (
        <EmptyState title={t('connections.empty')} />
      ) : (
        <div className="space-y-2">
          {connections.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                <span className="font-medium">{c.name}</span>
                <span className="text-xs uppercase text-muted-foreground">{c.kind}</span>
                <Badge variant={STATUS_VARIANT[c.status] ?? 'secondary'}>
                  {t(`connections.status.${c.status}`, { defaultValue: c.status })}
                </Badge>
                {c.serverVersion && <span className="text-xs text-muted-foreground">{c.serverVersion}</span>}
                <span className="flex-1" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => test.mutate(c.id)}
                  disabled={test.isPending}
                >
                  <RefreshCw className={test.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                  {t('connections.test')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    showLibraries.mutate(c.id, {
                      onSuccess: (result) => setLibraries({ name: c.name, result }),
                    })
                  }
                  disabled={showLibraries.isPending}
                >
                  <Library className="h-3.5 w-3.5" />
                  {t('connections.viewLibraries')}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {libraries && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <h2 className="text-sm font-semibold">{t('connections.librariesTitle', { name: libraries.name })}</h2>
            {!libraries.result.supported ? (
              <p className="text-sm text-warning">{t('connections.unsupported')}</p>
            ) : libraries.result.libraries.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <ul className="divide-y divide-white/5 rounded-md border border-white/5">
                {libraries.result.libraries.map((lib) => (
                  <li key={lib.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                    <span className="flex-1 truncate">{lib.name}</span>
                    <span className="text-xs text-muted-foreground">{lib.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
