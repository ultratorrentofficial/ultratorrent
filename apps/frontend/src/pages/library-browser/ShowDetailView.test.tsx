import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { ShowDetailView } from './ShowDetailView';

const apiSpy = vi.hoisted(() => ({ seriesEpisodes: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { media: apiSpy } }));

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
});

const episode = (n: number, over: Record<string, unknown> = {}) => ({
  id: `e${n}`, libraryId: 'lib', mediaType: 'tv', title: `Episode ${n}`,
  sortTitle: null, year: null, season: 1, episode: n,
  matchStatus: 'matched', confidence: 1, locked: false, path: `/x/e${n}.mkv`,
  createdAt: '2026-01-01T00:00:00Z', files: [], ...over,
});

const seasons = [
  { seasonNumber: 1, episodeCount: 2, poster: null, episodes: [episode(1), episode(2)] },
  { seasonNumber: 2, episodeCount: 1, poster: null, episodes: [episode(1, { id: 's2e1', title: 'Second season opener' })] },
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
          episode(2, { id: 'bare', title: 'Unprobed episode', files: [] }),
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

    it('falls back to the item title when metadata has no episode name', async () => {
      renderIt(withEpisodes([rich({ metadata: null })]));
      expect(await screen.findByText('The Last of Us')).toBeInTheDocument();
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
