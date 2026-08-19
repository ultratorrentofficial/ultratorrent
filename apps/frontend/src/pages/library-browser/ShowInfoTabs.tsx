import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, type MediaArtwork, type MediaSeason } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * A series' own metadata and artwork.
 *
 * A film has carried both since the beginning — its detail page shows the
 * record and lets an operator choose the poster. Television had neither: a show
 * is a folder grouping episodes, so its "poster" was whichever episode's row
 * sorted first and its "overview" belonged to an episode. Both now have an
 * owner of their own, and this is where an operator reaches them.
 */
export function ShowInfoTabs({ showId }: { showId: string }) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const qc = useQueryClient();
  /*
   * Season is a SCOPE, not a separate screen: the show and each of its seasons
   * hold artwork of their own, and switching between them is the same question
   * asked of a different scope.
   */
  const [season, setSeason] = useState<number | null>(null);

  const detail = useQuery({
    queryKey: ['show-detail', showId],
    queryFn: () => api.media.showDetail(showId),
  });

  const artwork = useQuery({
    queryKey: ['show-artwork', showId, season],
    queryFn: () => api.media.showArtwork(showId, season),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['show-detail', showId] });
    void qc.invalidateQueries({ queryKey: ['show-artwork', showId] });
    // The browse grid draws its poster from this artwork, so it is stale too.
    void qc.invalidateQueries({ queryKey: ['library-browser'] });
  };

  const refresh = useMutation({
    mutationFn: () => api.media.refreshShowMetadata(showId),
    onSuccess: (r) => {
      // "Refreshed nothing" is an outcome, not a success: a show with no
      // provider match must not report the same thing as one that was updated.
      if (r.refreshed) toast.success(t('show.metadata.refreshed'));
      else toast.error(t(`show.metadata.reason.${r.reason ?? 'not_found'}` as 'show.metadata.reason.not_found'));
      invalidate();
    },
    onError: () => toast.error(t('show.metadata.refreshFailed')),
  });

  const importArt = useMutation({
    mutationFn: () => api.media.importShowArtwork(showId, season),
    onSuccess: (r) => {
      if (r.imported?.length) toast.success(t('show.artwork.imported', { count: r.imported.length }));
      else toast.error(t('show.artwork.nothingImported'));
      invalidate();
    },
    onError: () => toast.error(t('show.artwork.importFailed')),
  });

  const choose = useMutation({
    mutationFn: (artworkId: string) => api.media.selectShowArtwork(showId, artworkId, season),
    onSuccess: () => {
      toast.success(t('show.artwork.selected'));
      invalidate();
    },
    onError: () => toast.error(t('show.artwork.selectFailed')),
  });

  if (detail.isLoading) return <CenteredSpinner label={t('show.loading')} />;
  if (detail.isError || !detail.data) {
    return <ErrorState message={t('show.loadFailed')} onRetry={() => detail.refetch()} />;
  }

  const { metadata, seasons } = detail.data;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('show.metadata.title')}</h3>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => refresh.mutate()}
            loading={refresh.isPending}
          >
            <RefreshCw className="h-4 w-4" /> {t('show.metadata.refresh')}
          </Button>
        </div>

        {metadata ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Field label={t('show.field.overview')} value={metadata.overview} wide />
            <Field label={t('show.field.status')} value={metadata.status} />
            <Field label={t('show.field.year')} value={metadata.year?.toString() ?? null} />
            <Field label={t('show.field.networks')} value={(metadata.networks ?? []).join(', ')} />
            <Field label={t('show.field.genres')} value={(metadata.genres ?? []).join(', ')} />
            <Field
              label={t('show.field.rating')}
              value={metadata.rating != null ? metadata.rating.toFixed(1) : null}
            />
            <Field label={t('show.field.provider')} value={metadata.providerName} />
          </dl>
        ) : (
          <EmptyState title={t('show.metadata.empty')} description={t('show.metadata.emptyHint')} />
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('show.artwork.title')}</h3>
          <div className="flex items-center gap-2">
            <Select
              className="h-8 w-auto"
              aria-label={t('show.artwork.scope')}
              value={season == null ? '' : String(season)}
              onChange={(e) => setSeason(e.target.value === '' ? null : Number(e.target.value))}
              options={[
                { value: '', label: t('show.artwork.wholeShow') },
                ...seasons.map((s: MediaSeason) => ({
                  value: String(s.seasonNumber),
                  label: t('show.artwork.season', { number: s.seasonNumber }),
                })),
              ]}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => importArt.mutate()}
              loading={importArt.isPending}
            >
              <ImageIcon className="h-4 w-4" /> {t('show.artwork.import')}
            </Button>
          </div>
        </div>

        {artwork.isLoading ? (
          <CenteredSpinner label={t('show.artwork.loading')} />
        ) : !artwork.data?.artwork.length ? (
          <EmptyState title={t('show.artwork.empty')} description={t('show.artwork.emptyHint')} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {artwork.data.artwork.map((a: MediaArtwork) => (
              <button
                key={a.id}
                type="button"
                onClick={() => choose.mutate(a.id)}
                disabled={a.selected || choose.isPending}
                title={a.selected ? t('show.artwork.isSelected') : t('show.artwork.choose')}
                className={cn(
                  'group relative overflow-hidden rounded-md border bg-white/[0.02] transition-colors',
                  a.selected ? 'border-sky-400' : 'border-white/10 hover:border-white/30',
                )}
              >
                <img
                  src={a.localPath ? `/api/media/artwork/${a.id}/image` : (a.url ?? '')}
                  alt={a.type}
                  loading="lazy"
                  className="aspect-[2/3] w-full object-cover"
                />
                <span className="absolute left-1 top-1">
                  <Badge variant={a.selected ? 'success' : 'secondary'}>{a.type}</Badge>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, value, wide }: { label: string; value?: string | null; wide?: boolean }) {
  // An absent field is omitted rather than rendered blank: a column of empty
  // labels reads as broken data instead of as data nobody has fetched yet.
  if (!value) return null;
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-line text-sm">{value}</dd>
    </div>
  );
}
