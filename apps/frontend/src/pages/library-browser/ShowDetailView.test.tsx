import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { ShowDetailView } from './ShowDetailView';

const apiSpy = vi.hoisted(() => ({
  seriesEpisodes: vi.fn(), seriesHealth: vi.fn(),
  bulkItems: vi.fn(), scanLibrary: vi.fn(),
  // The action bar is CAMA-driven now: it asks the server what may be done
  // rather than hardcoding buttons, so this surface needs a catalogue too.
  catalog: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: { media: apiSpy, contextActions: { catalog: apiSpy.catalog } },
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

// The poster resolves artwork through an authenticated fetch; the drill-down's
// behaviour has nothing to do with image bytes.
vi.mock('@/components/media/MediaPoster', () => ({
  MediaPoster: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

/*
 * The virtualizer is mocked to render every item.
 *
 * jsdom reports all elements as zero-sized, so a real virtualizer computes an
 * empty window and this suite would only ever prove that nothing renders.
 * Stubbing dimensions is not enough — the library measures through its own
 * observers. The geometry that decides what a window contains is covered
 * directly, and cheaply, in `view-mode.test.ts`; what matters here is the
 * drill-down behaviour around it.
 */
vi.mock('./VirtualPosterGrid', () => ({
  VirtualPosterGrid: ({ items, renderItem, itemKey, emptyState }: any) =>
    items.length
      ? <div>{items.map((it: unknown, i: number) => (
          <div key={itemKey(it, i)}>{renderItem(it, i)}</div>
        ))}</div>
      : <div>{emptyState}</div>,
}));

beforeEach(() => {
  apiSpy.seriesEpisodes.mockReset();
  // No health by default: the list must render before scores arrive, since
  // scoring every episode is heavier than listing them.
  apiSpy.seriesHealth.mockReset();
  apiSpy.seriesHealth.mockResolvedValue({
    score: 0, status: 'unknown', seasons: [], episodes: [],
    totals: { episodes: 0, seasons: 0, bytes: '0' },
  });

  apiSpy.catalog.mockReset();
  apiSpy.bulkItems.mockReset();
  apiSpy.bulkItems.mockResolvedValue({ jobId: 'j1', accepted: 1, missing: [] });
  // The bar only renders inside Operations Mode here, so the catalogue is the
  // Media Manager's item actions.
  apiSpy.catalog.mockResolvedValue({
    actions: [
      {
        id: 'media.metadata.refresh', group: 'metadata', entityTypes: ['media_item'],
        arity: 'any', operationsOnly: false, destructive: false,
        whenUnavailable: 'hide', async: true, order: 10,
      },
    ],
    diagnostics: { total: 1, withheld: { permission: 0, module: 0, feature: 0, provider: 0 } },
  });
});

const episode = (n: number, over: Record<string, unknown> = {}) => ({
  id: `e${n}`, libraryId: 'lib', mediaType: 'tv', title: `Episode ${n}`,
  sortTitle: null, year: null, season: 1, episode: n,
  matchStatus: 'matched', confidence: 1, locked: false,
  path: `/tv/Show/Season 1/Show - S01E0${n} - Episode ${n}.mkv`,
  createdAt: '2026-01-01T00:00:00Z', files: [], ...over,
});

const seasons = [
  { seasonNumber: 1, episodeCount: 2, poster: null, episodes: [episode(1), episode(2)] },
  { seasonNumber: 2, episodeCount: 1, poster: null, episodes: [episode(1, { id: 's2e1', path: '/tv/Show/Season 2/Show - S02E01 - Second season opener.mkv' })] },
];

function renderIt(data: unknown = { key: 'k', seasons }) {
  apiSpy.seriesEpisodes.mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShowDetailView showKey="k" libraryId="lib" title="The Last of Us" onBack={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ShowDetailView', () => {
  it('drills from show to seasons to episodes', async () => {
    renderIt();
    expect(await screen.findByText('The Last of Us')).toBeInTheDocument();
    expect(await screen.findByText('Season 1')).toBeInTheDocument();
    expect(screen.getByText('Season 2')).toBeInTheDocument();
    // Lands on the first season rather than an accordion the user must open.
    expect(await screen.findByText('Episode 1')).toBeInTheDocument();
  });

  it('switches the episode list when another season is chosen', async () => {
    renderIt();
    fireEvent.click(await screen.findByText('Season 2'));
    expect(await screen.findByText('Second season opener')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Episode 2')).not.toBeInTheDocument());
  });

  it('labels season zero as Specials rather than "Season 0"', async () => {
    renderIt({ key: 'k', seasons: [{ seasonNumber: 0, episodeCount: 1, poster: null, episodes: [episode(1)] }] });
    expect(await screen.findByText('Specials')).toBeInTheDocument();
    expect(screen.queryByText('Season 0')).not.toBeInTheDocument();
  });

  it('shows technical facts only where the file actually has them', async () => {
    renderIt({
      key: 'k',
      seasons: [{
        seasonNumber: 1, episodeCount: 2, poster: null,
        episodes: [
          episode(1, { files: [{ id: 'f1', itemId: 'e1', path: '/x', size: '1', container: null,
            videoCodec: 'HEVC', audioCodec: null, resolution: '2160p', hdr: 'HDR10',
            language: null, releaseGroup: null, quality: null, createdAt: '' }] }),
          episode(2, { id: 'bare', path: '/tv/Show/Season 1/Show - S01E02 - Unprobed episode.mkv', files: [] }),
        ],
      }],
    });
    expect(await screen.findByText('2160p · HDR10 · HEVC')).toBeInTheDocument();
    // The renamer strips these tokens, so most files carry none until probed.
    // A row of dashes would imply the data is missing rather than unmeasured.
    const bare = await screen.findByText('Unprobed episode');
    expect(bare.parentElement?.textContent).toBe('Unprobed episode');
  });

  describe('episode rows carry their own info and art', () => {
    const rich = (over: Record<string, unknown> = {}) => episode(3, {
      title: 'The Last of Us',                       // MediaItem.title is the SHOW
      // A release-style filename carries no episode name, so metadata answers —
      // the "enriched at episode level" case.
      path: '/tv/The Last of Us/Season 1/The.Last.of.Us.S01E03.1080p.WEB-DL.mkv',
      metadata: { title: 'Long Long Time', runtime: 76 },
      artwork: [
        { id: 'a1', type: 'poster', url: '/p.jpg', localPath: null, selected: true },
        { id: 'a2', type: 'episode_thumbnail', url: '/still.jpg', localPath: null, selected: false },
      ],
      files: [{ id: 'f', itemId: 'e3', path: '/x', size: '1', container: 'mkv',
        videoCodec: 'HEVC', audioCodec: null, resolution: '2160p', hdr: 'HDR10',
        language: null, releaseGroup: null, quality: null, createdAt: '' }],
      _count: { subtitles: 3 },
      ...over,
    });

    const withEpisodes = (eps: unknown[]) =>
      ({ key: 'k', seasons: [{ seasonNumber: 1, episodeCount: eps.length, poster: null, episodes: eps }] });

    it('shows the EPISODE name, not the show name', async () => {
      // MediaItem.title holds the show (taken from the folder, since a filename
      // usually carries only the episode name), so the episode name is metadata.
      renderIt(withEpisodes([rich()]));
      expect(await screen.findByText('Long Long Time')).toBeInTheDocument();
    });

    it('uses the episode still rather than the show poster', async () => {
      // Falling back to the poster would repeat one image down the whole list
      // and say nothing about the episode.
      renderIt(withEpisodes([rich()]));
      expect(await screen.findByAltText('Long Long Time')).toBeInTheDocument();
    });

    it('renders runtime alongside the technical facts', async () => {
      renderIt(withEpisodes([rich()]));
      expect(await screen.findByText('2160p · HDR10 · HEVC · 76 min')).toBeInTheDocument();
    });

    it('shows a subtitle count only when there are subtitles', async () => {
      renderIt(withEpisodes([rich(), rich({ id: 'none', metadata: { title: 'Silent' }, _count: { subtitles: 0 } })]));
      expect(await screen.findByTitle('3 subtitles')).toBeInTheDocument();
      // A "0" badge would read as a defect rather than as an absence.
      expect(screen.queryByTitle('0 subtitles')).not.toBeInTheDocument();
    });

    it('says "Episode N" rather than repeating the series name', async () => {
      /*
       * Both MediaItem.title and metadata.title hold the SHOW's name on a real
       * library — measured: all eight episodes of A Gentleman in Moscow carried
       * the series name in metadata. Echoing it would repeat one string down
       * every row and identify nothing.
       */
      renderIt(withEpisodes([rich({ metadata: null })]));
      expect(await screen.findByText('Episode 3')).toBeInTheDocument();
      // Once, as the page heading — not again in the row beneath it.
      expect(screen.getAllByText('The Last of Us')).toHaveLength(1);
    });

    it('prefers the filename when the renamer wrote the episode name', async () => {
      renderIt(withEpisodes([rich({
        path: '/tv/x/The Last of Us - S01E03 - Long, Long Time.mkv', metadata: null,
      })]));
      expect(await screen.findByText('Long, Long Time')).toBeInTheDocument();
    });
  });

  describe('health', () => {
    const withHealth = (over: Record<string, unknown>) => {
      apiSpy.seriesHealth.mockResolvedValue({
        score: 92, status: 'healthy',
        seasons: [{ seasonNumber: 1, episodes: 2, score: 92, status: 'healthy', reasonCounts: {} }],
        episodes: [
          { itemId: 'e1', season: 1, episode: 1, score: 93, status: 'healthy', reasons: ['missing_subtitles'] },
          { itemId: 'e2', season: 1, episode: 2, score: 83, status: 'attention', reasons: ['unorganised_path'] },
        ],
        totals: { episodes: 2, seasons: 1, bytes: '123' },
        ...over,
      });
    };

    it('shows the show score, the season score and each episode score', async () => {
      withHealth({});
      renderIt();
      // 92 appears twice — the show header and its single season — which is
      // itself the assertion that both levels render.
      expect(await screen.findAllByLabelText('Healthy — 92')).toHaveLength(2);
      expect(await screen.findByLabelText('Healthy — 93')).toBeInTheDocument();
      expect(await screen.findByLabelText('Needs attention — 83')).toBeInTheDocument();
    });

    it('explains a badge through its reasons', async () => {
      // A number alone tells an operator something is wrong but not what.
      withHealth({});
      renderIt();
      expect(await screen.findByTitle('Not filed into a season folder')).toBeInTheDocument();
    });

    it('renders the episode list before health arrives', async () => {
      /*
       * Scoring every episode of a show is heavier than listing them, so a slow
       * score must never delay first paint.
       */
      apiSpy.seriesHealth.mockImplementation(() => new Promise(() => {}));
      renderIt();
      expect(await screen.findByText('Episode 1')).toBeInTheDocument();
    });

    it('still renders the list when scoring fails outright', async () => {
      apiSpy.seriesHealth.mockRejectedValue(new Error('boom'));
      renderIt();
      expect(await screen.findByText('Episode 1')).toBeInTheDocument();
    });

    it('shows a dash rather than a zero for an unscored show', async () => {
      // "Nothing to score" is not "all good", and a 0 would read as a failure.
      renderIt();
      const badge = await screen.findByLabelText('Not scored — 0');
      expect(badge.textContent).toContain('—');
    });
  });

  describe('Operations Mode', () => {
    const openOps = async () => {
      renderIt();
      await screen.findByText('Episode 1');
      fireEvent.click(screen.getByText('Operations'));
    };

    it('is off until asked for', async () => {
      /*
       * Most visits are to look at a show, not maintain it. Permanent
       * checkboxes make a media page feel like a file manager.
       */
      renderIt();
      await screen.findByText('Episode 1');
      expect(screen.queryByLabelText('Select episode 1')).not.toBeInTheDocument();
      expect(screen.queryByText('Nothing selected')).not.toBeInTheDocument();
    });

    it('reveals checkboxes and the bulk toolbar', async () => {
      await openOps();
      expect(await screen.findByLabelText('Select episode 1')).toBeInTheDocument();
      expect(screen.getByText('Nothing selected')).toBeInTheDocument();
    });

    it('selects an episode and offers operations over it', async () => {
      await openOps();
      fireEvent.click(await screen.findByLabelText('Select episode 1'));
      expect(await screen.findByText('1 selected')).toBeInTheDocument();
      expect(screen.getByText('Refresh metadata')).toBeInTheDocument();
    });

    it('sends the selection to the bulk endpoint as one request', async () => {
      apiSpy.bulkItems.mockResolvedValue({ jobId: 'j1', accepted: 1, missing: [] });
      await openOps();
      fireEvent.click(await screen.findByLabelText('Select episode 1'));
      fireEvent.click(await screen.findByText('Refresh metadata'));
      await waitFor(() => expect(apiSpy.bulkItems).toHaveBeenCalledWith('metadata', ['e1']));
    });

    it('drops the selection when Operations Mode is left', async () => {
      // A selection that outlived its mode would act on rows nobody can see.
      await openOps();
      fireEvent.click(await screen.findByLabelText('Select episode 1'));
      await screen.findByText('1 selected');
      fireEvent.click(screen.getByText('Operations'));
      await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
    });

    it('drops the selection when another season is opened', async () => {
      await openOps();
      fireEvent.click(await screen.findByLabelText('Select episode 1'));
      await screen.findByText('1 selected');
      fireEvent.click(screen.getByText('Season 2'));
      await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
    });
  });

  it('flags an unmatched episode', async () => {
    renderIt({
      key: 'k',
      seasons: [{ seasonNumber: 1, episodeCount: 1, poster: null,
        episodes: [episode(1, { matchStatus: 'unmatched' })] }],
    });
    expect(await screen.findByText('Unmatched')).toBeInTheDocument();
  });

  it('reports an empty show rather than rendering a blank panel', async () => {
    renderIt({ key: 'k', seasons: [] });
    expect(await screen.findByText('No episodes found for this show.')).toBeInTheDocument();
  });

  it('surfaces a failure with a retry instead of hanging', async () => {
    apiSpy.seriesEpisodes.mockRejectedValue(new Error('boom'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ShowDetailView showKey="k" libraryId="lib" title="X" onBack={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Could not load the library.')).toBeInTheDocument();
  });

  it('calls back with the library, so Back returns to the wall', async () => {
    const onBack = vi.fn();
    apiSpy.seriesEpisodes.mockResolvedValue({ key: 'k', seasons });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ShowDetailView showKey="k" libraryId="lib" title="X" onBack={onBack} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByText('Back to library'));
    expect(onBack).toHaveBeenCalled();
  });
});
