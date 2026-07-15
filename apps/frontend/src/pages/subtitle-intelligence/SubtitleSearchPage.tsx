import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Download, Search, ShieldCheck } from 'lucide-react';
import { api, type SubtitleCandidate } from '@/lib/api';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';

const TIER_VARIANT: Record<string, BadgeVariant> = {
  auto: 'success',
  download: 'info',
  present: 'warning',
  reject: 'destructive',
};

export function SubtitleSearchPage() {
  const { t } = useTranslation('subtitleIntelligence');
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canDownload = hasPermission(PERMISSIONS.SUBTITLE_INTELLIGENCE_DOWNLOAD);

  const [params, setParams] = useSearchParams();
  const [itemId, setItemId] = useState(params.get('itemId') ?? '');
  const [languages, setLanguages] = useState(params.get('lang') ?? 'en');
  const [candidates, setCandidates] = useState<SubtitleCandidate[] | null>(null);
  const [warning, setWarning] = useState<string | undefined>();

  const search = useMutation({
    mutationFn: () =>
      api.subtitles.search(itemId.trim(), {
        languages: languages.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: (r) => {
      setCandidates(r.candidates);
      setWarning(r.warning);
      setParams({ itemId: itemId.trim(), lang: languages });
    },
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  const download = useMutation({
    mutationFn: (candidateId: string) => api.subtitles.download(candidateId),
    onSuccess: (r) => {
      if (r.installed) toast.success(t('search.installed'));
      else toast.error(t('search.notInstalled'), r.reason ?? r.error);
    },
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Search className="h-6 w-6 text-primary" /> {t('search.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('search.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[280px] flex-1">
            <Label htmlFor="item-id">{t('search.itemId')}</Label>
            <Input id="item-id" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder={t('search.itemIdHint')} />
          </div>
          <div className="w-40">
            <Label htmlFor="langs">{t('search.languages')}</Label>
            <Input id="langs" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="en,es" />
          </div>
          <Button onClick={() => search.mutate()} loading={search.isPending} disabled={!itemId.trim()}>
            <Search className="mr-1 h-4 w-4" /> {t('search.run')}
          </Button>
        </CardContent>
      </Card>

      {warning && (
        <Card>
          <CardContent className="p-4 text-sm text-warning">{warning}</CardContent>
        </Card>
      )}

      {candidates && candidates.length === 0 && !warning && (
        <EmptyState icon={<Search className="h-6 w-6" />} title={t('search.noResults')} description={t('search.noResultsHint')} />
      )}

      {candidates && candidates.length > 0 && (
        <div className="space-y-2">
          {candidates.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={TIER_VARIANT[c.scoreTier ?? 'present'] ?? 'secondary'}>
                      {c.score} · {t(`tier.${c.scoreTier ?? 'present'}`, { defaultValue: c.scoreTier ?? 'present' })}
                    </Badge>
                    <span className="font-medium uppercase">{c.language}</span>
                    <span className="text-sm text-muted-foreground">{c.provider}</span>
                    {c.matchLevel === 1 && (
                      <Badge variant="success">
                        <ShieldCheck className="mr-1 h-3 w-3" /> {t('search.hashMatch')}
                      </Badge>
                    )}
                    {c.hearingImpaired && <Badge variant="outline">SDH</Badge>}
                    {c.forced && <Badge variant="outline">{t('search.forced')}</Badge>}
                    {c.trustedUploader && <Badge variant="info">{t('search.trusted')}</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{c.releaseName ?? c.filename ?? '—'}</p>
                </div>
                {canDownload && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={c.scoreTier === 'reject'}
                    loading={download.isPending && download.variables === c.id}
                    onClick={() => download.mutate(c.id)}
                  >
                    <Download className="mr-1 h-4 w-4" /> {t('search.download')}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
