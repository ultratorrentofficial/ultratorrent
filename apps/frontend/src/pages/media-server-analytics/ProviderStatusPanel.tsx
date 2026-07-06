import { useTranslation } from 'react-i18next';
import { RefreshCw, Server } from 'lucide-react';
import type { MediaServerConnectionSummary } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

function statusVariant(status: string): 'success' | 'destructive' | 'secondary' {
  if (status === 'online') return 'success';
  if (status === 'offline') return 'destructive';
  return 'secondary';
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Provider health panel — one card per connected media server with its live
 * status, version, platform, and last health-check time. Sourced from the
 * dashboard's connection summaries (no extra request).
 */
export function ProviderStatusPanel({
  connections,
  onSync,
  syncing,
}: {
  connections: MediaServerConnectionSummary[];
  onSync?: () => void;
  syncing?: boolean;
}) {
  const { t } = useTranslation('mediaServerAnalytics');

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Server className="h-4 w-4 text-muted-foreground" />
          {t('providerStatus.title')}
        </h2>
        {onSync && (
          <Button variant="subtle" size="sm" onClick={onSync} loading={syncing}>
            <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
            {t('providerStatus.sync')}
          </Button>
        )}
      </div>
      {connections.length === 0 ? (
        <EmptyState title={t('providerStatus.empty')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {connections.map((c) => (
            <Card key={c.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  <Badge variant={statusVariant(c.status)}>
                    {t(`connections.status.${c.status === 'online' || c.status === 'offline' ? c.status : 'unknown'}`)}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="uppercase tracking-wide">{c.kind}</span>
                  {c.serverVersion && <span>· v{c.serverVersion}</span>}
                  {c.platform && <span>· {c.platform}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('providerStatus.lastCheck')}: {relativeTime(c.lastHealthCheckAt)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
