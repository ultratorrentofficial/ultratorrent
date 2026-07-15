import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Clock, Wand2 } from 'lucide-react';
import { api, type SubtitleDownloadRow } from '@/lib/api';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

function DownloadRow({ dl, ffAvailable, canSync }: { dl: SubtitleDownloadRow; ffAvailable: boolean; canSync: boolean }) {
  const { t } = useTranslation('subtitleIntelligence');
  const toast = useToast();
  const qc = useQueryClient();
  const [offset, setOffset] = useState('0');

  const run = useMutation({
    mutationFn: (body: { method?: 'auto' | 'manual'; offsetMs?: number }) => api.subtitles.synchronize(dl.id, body),
    onSuccess: (r) => {
      if (r.synced) toast.success(t('sync.done'));
      else toast.error(t('sync.skipped'), r.reason ?? r.error);
      void qc.invalidateQueries({ queryKey: ['subtitles', 'downloads'] });
    },
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium uppercase">{dl.language}</span>
            <span className="text-sm text-muted-foreground">{dl.provider}</span>
            <Badge variant={dl.status === 'installed' ? 'success' : 'secondary'}>{dl.status}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">{dl.path}</p>
        </div>
        {canSync && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!ffAvailable}
              loading={run.isPending && run.variables?.method === 'auto'}
              onClick={() => run.mutate({ method: 'auto' })}
              title={ffAvailable ? undefined : t('sync.ffUnavailable')}
            >
              <AudioLines className="mr-1 h-4 w-4" /> {t('sync.auto')}
            </Button>
            <div className="flex items-center gap-1">
              <Input
                className="w-24"
                type="number"
                value={offset}
                onChange={(e) => setOffset(e.target.value)}
                aria-label={t('sync.offsetMs')}
              />
              <Button
                size="sm"
                variant="outline"
                loading={run.isPending && run.variables?.method === 'manual'}
                onClick={() => run.mutate({ method: 'manual', offsetMs: Number(offset) || 0 })}
              >
                <Clock className="mr-1 h-4 w-4" /> {t('sync.applyOffset')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SubtitleSyncPage() {
  const { t } = useTranslation('subtitleIntelligence');
  const { hasPermission } = useAuth();
  const canSync = hasPermission(PERMISSIONS.SUBTITLE_INTELLIGENCE_SYNCHRONIZE);

  const caps = useQuery({ queryKey: ['subtitles', 'sync-caps'], queryFn: () => api.subtitles.syncCapabilities() });
  const downloads = useQuery({ queryKey: ['subtitles', 'downloads'], queryFn: () => api.subtitles.downloads() });

  if (downloads.isLoading || caps.isLoading) return <CenteredSpinner label={t('common.loading')} />;
  if (downloads.isError) return <ErrorState title={t('common.error')} onRetry={() => downloads.refetch()} />;

  const ffAvailable = caps.data?.ffsubsync.available ?? false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Wand2 className="h-6 w-6 text-primary" /> {t('sync.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('sync.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-4 text-sm">
          <span className="text-muted-foreground">{t('sync.engines')}:</span>
          <Badge variant={ffAvailable ? 'success' : 'outline'}>
            FFsubsync {ffAvailable ? `· ${caps.data?.ffsubsync.version ?? 'ready'}` : `· ${t('sync.notInstalled')}`}
          </Badge>
          <Badge variant="success">{t('sync.manualOffset')}</Badge>
          {!ffAvailable && <span className="text-xs text-muted-foreground">{t('sync.ffHint')}</span>}
        </CardContent>
      </Card>

      {(downloads.data?.length ?? 0) === 0 ? (
        <EmptyState icon={<Wand2 className="h-6 w-6" />} title={t('sync.empty')} description={t('sync.emptyHint')} />
      ) : (
        <div className="space-y-2">
          {downloads.data!.map((dl) => (
            <DownloadRow key={dl.id} dl={dl} ffAvailable={ffAvailable} canSync={canSync} />
          ))}
        </div>
      )}
    </div>
  );
}
