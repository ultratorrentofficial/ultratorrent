import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, RefreshCw, Telescope } from 'lucide-react';
import { api, type DiscoveredMediaItem } from '@/lib/api';
import { ProvidersPanel } from './ProvidersPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * The Discovery Inbox.
 *
 * The organising idea is that **every title here carries the reason it is
 * here**. A discovery engine that silently monitors things is one an operator
 * cannot trust or correct, so the decision and its reason are on the card
 * itself — not behind a detail view somebody has to think to open.
 */

/** The views the tabs offer, each a filter over the same endpoint. */
const VIEWS = [
  { id: 'all', status: undefined, decision: undefined },
  { id: 'monitored', status: 'monitored', decision: undefined },
  { id: 'needsReview', status: 'needs_review', decision: undefined },
  { id: 'notified', status: 'notified', decision: undefined },
  { id: 'ignored', status: 'ignored', decision: undefined },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

/** Decision → the visual weight it should carry. */
function decisionTone(decision: string | null): { label: string; className: string } {
  switch (decision) {
    case 'auto_monitor':
      return { label: 'Monitored', className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' };
    case 'needs_review':
      return { label: 'Needs review', className: 'border-amber-400/40 bg-amber-400/10 text-amber-300' };
    case 'notify':
      return { label: 'Notify', className: 'border-sky-400/40 bg-sky-400/10 text-sky-300' };
    case 'ignore':
      return { label: 'Ignored', className: 'border-white/10 bg-white/5 text-muted-foreground' };
    default:
      return { label: 'Not evaluated', className: 'border-white/10 bg-white/5 text-muted-foreground' };
  }
}

function DiscoveryCard({ item }: { item: DiscoveredMediaItem }) {
  const { t } = useTranslation('mediaDiscovery');
  const tone = decisionTone(item.decision);
  const next = item.releaseDates.find((d) => d.date);

  return (
    <Card>
      <CardContent className="flex gap-3 p-3">
        {item.posterUrl ? (
          <img
            src={item.posterUrl}
            alt=""
            loading="lazy"
            className="h-28 w-20 shrink-0 rounded object-cover"
          />
        ) : (
          <div className="flex h-28 w-20 shrink-0 items-center justify-center rounded bg-white/5 text-lg text-muted-foreground">
            {item.title[0] ?? '?'}
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="truncate text-sm font-semibold">{item.title}</h3>
            {item.year && <span className="text-xs text-muted-foreground">({item.year})</span>}
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone.className}`}>
              {tone.label}
            </span>
          </div>

          {/*
            * The reason, always. A title that was monitored, ignored or held has
            * an explanation and it belongs on the card — putting it behind a
            * detail view makes the common question the expensive one.
            */}
          {item.decisionReason && (
            <p className="line-clamp-2 text-xs text-muted-foreground">{item.decisionReason}</p>
          )}

          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {item.genres.slice(0, 3).map((g) => (
              <span key={g} className="rounded bg-white/5 px-1.5 py-0.5">
                {g}
              </span>
            ))}
            {next?.date && (
              <span>
                {t('card.releases', { date: next.date, type: next.releaseType })}
              </span>
            )}
            {item.network && <span>· {item.network}</span>}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{t('card.sources', { list: item.sourceProviders.join(', ') })}</span>
            {/*
              * Confidence is shown whenever the identity is not resolved, because
              * that is precisely when a person needs to know the engine was unsure
              * rather than wrong.
              */}
            {item.identityStatus !== 'resolved' && (
              <span className="flex items-center gap-1 text-amber-300">
                <AlertTriangle className="h-3 w-3" />
                {item.identityStatus === 'conflicted'
                  ? t('identity.conflicted')
                  : t('identity.ambiguous')}
              </span>
            )}
            {item.watchlistItemId && <span className="text-emerald-300">{t('card.onWatchlist')}</span>}
            {item.rssRuleId && <span className="text-emerald-300">{t('card.hasRule')}</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DiscoverPage() {
  const { t } = useTranslation('mediaDiscovery');
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'inbox' | 'templates' | 'providers'>('inbox');
  const [view, setView] = useState<ViewId>('all');
  const [search, setSearch] = useState('');
  const [mediaType, setMediaType] = useState('');

  const selected = VIEWS.find((v) => v.id === view)!;

  const providers = useQuery({
    queryKey: ['discovery', 'providers'],
    queryFn: () => api.mediaDiscovery.providers(),
  });

  const inbox = useQuery({
    queryKey: ['discovery', 'inbox', view, search, mediaType],
    queryFn: () =>
      api.mediaDiscovery.inbox({
        status: selected.status,
        decision: selected.decision,
        mediaType: mediaType || undefined,
        search: search || undefined,
        pageSize: 60,
      }),
  });

  const sync = useMutation({
    mutationFn: () => api.mediaDiscovery.sync(),
    onSuccess: () => {
      toast.success(t('actions.syncQueued'));
      qc.invalidateQueries({ queryKey: ['discovery'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const anyEnabled = (providers.data ?? []).some((p) => p.enabled);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Telescope className="h-5 w-5" />
            {t('title')}
          </h1>
          <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button onClick={() => sync.mutate()} disabled={sync.isPending || !anyEnabled}>
          <RefreshCw className={`h-3.5 w-3.5 ${sync.isPending ? 'animate-spin' : ''}`} />
          {t('actions.sync')}
        </Button>
      </div>

      {/*
        * First-run guidance rather than an empty grid. Nothing here works until a
        * provider is enabled, and a page that simply showed nothing would leave
        * the reason to be guessed at.
        */}
      {providers.isSuccess && !anyEnabled && (
        <Card>
          <CardContent className="space-y-1 p-4">
            <h2 className="text-sm font-semibold">{t('firstRun.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('firstRun.body')}</p>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
        {(['inbox', 'templates', 'providers'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              tab === id ? 'bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>

      {tab === 'providers' && <ProvidersPanel />}
      {tab === 'templates' && <TemplatesPanel />}

      {tab === 'inbox' && (
      <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                view === v.id ? 'bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`views.${v.id}`)}
            </button>
          ))}
        </div>
        <Select value={mediaType} onChange={(e) => setMediaType(e.target.value)} className="w-36">
          <option value="">{t('filters.allTypes')}</option>
          <option value="movie">{t('filters.movies')}</option>
          <option value="tv">{t('filters.tv')}</option>
        </Select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('filters.search')}
          className="w-56"
        />
      </div>

      {inbox.isLoading && <CenteredSpinner />}
      {inbox.isError && <ErrorState title={t('inbox.error')} />}
      {inbox.isSuccess && inbox.data.items.length === 0 && (
        <EmptyState
          icon={<Eye className="h-6 w-6" />}
          title={t('inbox.emptyTitle')}
          description={t('inbox.emptyDescription')}
        />
      )}
      {inbox.isSuccess && inbox.data.items.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            {t('inbox.count', { shown: inbox.data.items.length, total: inbox.data.total })}
          </p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {inbox.data.items.map((item) => (
              <DiscoveryCard key={item.id} item={item} />
            ))}
          </div>
        </>
      )}
      </>
      )}
    </div>
  );
}
