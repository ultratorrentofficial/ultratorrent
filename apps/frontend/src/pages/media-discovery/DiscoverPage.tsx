import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, RefreshCw, Telescope, Trash2 } from 'lucide-react';
import { api, type DiscoveredMediaItem } from '@/lib/api';
import { ProvidersPanel } from './ProvidersPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { DuplicatesPanel } from './DuplicatesPanel';
import { AcquisitionLadderPanel } from './AcquisitionLadderPanel';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { Pagination } from '@/components/ui/pagination';
import { RemoveDiscoveryDialog } from './RemoveDiscoveryDialog';

/*
 * 24 rather than 60: three columns at xl, so every page fills its rows exactly,
 * and a page is small enough that the pagination control is reachable without
 * scrolling past a screen of cards to find it.
 */
const INBOX_PAGE_SIZE = 24;

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
  /*
   * Titles already represented here. Their own view rather than a line in the
   * review queue: they need nobody, and burying them among things that DO need
   * somebody is how a review queue stops being read.
   */
  { id: 'existing', status: 'exists', decision: undefined },
  /* Series that already premiered — a person decides, so they need finding. */
  { id: 'pastRelease', status: 'past_release', decision: undefined },
  { id: 'notified', status: 'notified', decision: undefined },
  { id: 'ignored', status: 'ignored', decision: undefined },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

/**
 * Decision → the visual weight it should carry, and the key that names it.
 *
 * A key rather than a literal: these labels were hardcoded English on a page
 * that ships in two locales, so a Spanish reader saw "Needs review" on every
 * card.
 */
const MUTED = 'border-white/10 bg-white/5 text-muted-foreground';

/** Literal, so the `decision.*` lookup stays inside i18next's typed key set. */
type DecisionKey =
  | 'monitored'
  | 'needsReview'
  | 'notify'
  | 'ignored'
  | 'notEvaluated'
  | 'alreadyMonitored'
  | 'monitoringIncomplete'
  | 'existsNotMonitored'
  | 'reviewPastRelease';

function decisionTone(decision: string | null): { key: DecisionKey; className: string } {
  switch (decision) {
    case 'auto_monitor':
      return { key: 'monitored', className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' };
    case 'needs_review':
      return { key: 'needsReview', className: 'border-amber-400/40 bg-amber-400/10 text-amber-300' };
    case 'notify':
      return { key: 'notify', className: 'border-sky-400/40 bg-sky-400/10 text-sky-300' };
    case 'ignore':
      return { key: 'ignored', className: MUTED };
    /*
     * Neutral, deliberately. "Already monitored" is a satisfactory outcome, and
     * colouring it like a warning would send people to investigate something
     * that is working exactly as intended.
     */
    case 'already_monitored':
      return { key: 'alreadyMonitored', className: 'border-emerald-400/25 bg-emerald-400/5 text-emerald-200/80' };
    case 'exists_monitoring_incomplete':
      return { key: 'monitoringIncomplete', className: 'border-amber-400/40 bg-amber-400/10 text-amber-300' };
    case 'review_past_release':
      return { key: 'reviewPastRelease', className: 'border-amber-400/30 bg-amber-400/5 text-amber-200/90' };
    case 'exists_not_monitored':
      return { key: 'existsNotMonitored', className: 'border-sky-400/30 bg-sky-400/5 text-sky-200/80' };
    default:
      return { key: 'notEvaluated', className: MUTED };
  }
}

function DiscoveryCard({ item, onRemove }: { item: DiscoveredMediaItem; onRemove: () => void }) {
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
              {t(`decision.${tone.key}`)}
            </span>
            {/*
              * Removal lives on the card, not behind a detail view.
              *
              * The catalogue is where somebody notices a show they do not want,
              * and making them open a page to act on it is the reason the
              * catalogue felt unmanageable. The dialog does the explaining.
              */}
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
              title={t('remove.action')}
              aria-label={t('remove.actionFor', { title: item.title })}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
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
  const [tab, setTab] = useState<'inbox' | 'templates' | 'ladders' | 'providers' | 'duplicates'>('inbox');
  const [view, setView] = useState<ViewId>('all');
  const [search, setSearch] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [page, setPage] = useState(1);
  /* The title whose removal dialog is open, if any. */
  const [removing, setRemoving] = useState<DiscoveredMediaItem | null>(null);

  const selected = VIEWS.find((v) => v.id === view)!;

  const providers = useQuery({
    queryKey: ['discovery', 'providers'],
    queryFn: () => api.mediaDiscovery.providers(),
  });

  /*
   * Filters reset to the first page.
   *
   * Without this, narrowing a 900-title catalogue while on page 8 lands on a
   * page that no longer exists and renders as an empty inbox — which reads as
   * "the filter matched nothing".
   */
  useEffect(() => {
    setPage(1);
  }, [view, search, mediaType]);

  const inbox = useQuery({
    queryKey: ['discovery', 'inbox', view, search, mediaType, page],
    queryFn: () =>
      api.mediaDiscovery.inbox({
        status: selected.status,
        decision: selected.decision,
        mediaType: mediaType || undefined,
        search: search || undefined,
        page,
        pageSize: INBOX_PAGE_SIZE,
      }),
    // The grid keeps the previous page while the next loads, so paging does not
    // flash an empty state between two full pages.
    placeholderData: keepPreviousData,
  });

  const sync = useMutation({
    mutationFn: () => api.mediaDiscovery.sync(),
    onSuccess: (result) => {
      /*
       * A refresh now re-decides the whole catalogue, so it reports what that
       * did. "Refresh started" was accurate and useless: the button is pressed
       * after editing a template, and the question being asked is whether the
       * edit changed anything.
       */
      toast.success(
        t('actions.syncDone', {
          examined: result.evaluation.examined,
          monitored: result.evaluation.monitored,
        }),
      );
      if (result.evaluation.retracted > 0) {
        toast.info(
          t('actions.syncRetracted', {
            count: result.evaluation.retracted,
            removed: result.evaluation.removedFromCatalog,
          }),
        );
      }
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
        {(['inbox', 'templates', 'ladders', 'providers', 'duplicates'] as const).map((id) => (
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
      {tab === 'ladders' && <AcquisitionLadderPanel />}
      {tab === 'duplicates' && <DuplicatesPanel />}

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
              <DiscoveryCard key={item.id} item={item} onRemove={() => setRemoving(item)} />
            ))}
          </div>
          <Pagination
            page={page}
            pageSize={INBOX_PAGE_SIZE}
            total={inbox.data.total}
            onPage={setPage}
            busy={inbox.isFetching}
          />
        </>
      )}
      </>
      )}

      {removing && (
        <RemoveDiscoveryDialog
          item={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            qc.invalidateQueries({ queryKey: ['discovery'] });
          }}
        />
      )}
    </div>
  );
}
