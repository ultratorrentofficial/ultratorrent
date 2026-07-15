import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Captions, Download, Server, Settings2, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';

export function SubtitleDashboardPage() {
  const { t } = useTranslation('subtitleIntelligence');
  const navigate = useNavigate();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['subtitles', 'dashboard'],
    queryFn: () => api.subtitles.dashboard(),
  });

  if (isLoading) return <CenteredSpinner label={t('common.loading')} />;
  if (isError || !data) return <ErrorState title={t('common.error')} onRetry={() => refetch()} />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Captions className="h-6 w-6 text-primary" /> {t('title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate('/subtitles/search')}>
            <Search className="mr-1 h-4 w-4" /> {t('nav.search')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate('/subtitles/providers')}>
            <Settings2 className="mr-1 h-4 w-4" /> {t('nav.providers')}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Download className="h-4 w-4" /> {t('dashboard.installed')}
            </div>
            <div className="mt-2 text-3xl font-semibold">{data.totals.installed}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Download className="h-4 w-4" /> {t('dashboard.downloads')}
            </div>
            <div className="mt-2 text-3xl font-semibold">{data.totals.downloads}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Server className="h-4 w-4" /> {t('dashboard.providers')}
            </div>
            <div className="mt-2 text-3xl font-semibold">
              {data.providers.filter((p) => p.isEnabled).length}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('dashboard.providerHealth')}
          </h2>
          {data.providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('dashboard.noProviders')}</p>
          ) : (
            <ul className="space-y-2">
              {data.providers.map((p) => (
                <li key={p.provider} className="flex items-center justify-between text-sm">
                  <span className="font-medium">{p.provider}</span>
                  <span className="flex items-center gap-2">
                    {p.quotaRemaining != null && (
                      <span className="text-xs text-muted-foreground">
                        {t('dashboard.quota', { n: p.quotaRemaining })}
                      </span>
                    )}
                    <Badge variant={!p.isEnabled ? 'outline' : p.healthy ? 'success' : 'warning'}>
                      {!p.isEnabled ? t('status.disabled') : p.healthy ? t('status.healthy') : t('status.unknown')}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('dashboard.byLanguage')}
          </h2>
          {data.byLanguage.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('dashboard.empty')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.byLanguage.map((l) => (
                <Badge key={l.language} variant="secondary">
                  {l.language.toUpperCase()} · {l.count}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
