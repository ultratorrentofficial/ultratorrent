import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/i18n';
import type { ShowHealth } from '@/lib/api';
import { ShowOverview, aggregateReasons, formatBytes } from './ShowOverview';

const health = (over: Partial<ShowHealth> = {}): ShowHealth => ({
  score: 92, status: 'healthy',
  seasons: [
    { seasonNumber: 1, episodes: 8, score: 93, status: 'healthy',
      reasonCounts: { missing_subtitles: 8, unorganised_path: 1 } },
    { seasonNumber: 2, episodes: 4, score: 70, status: 'attention',
      reasonCounts: { missing_subtitles: 4, missing_artwork: 3 } },
  ],
  episodes: [],
  totals: { episodes: 12, seasons: 2, bytes: '49392123456' },
  ...over,
});

describe('formatBytes', () => {
  it('scales to binary units', () => {
    // 46 is above the ten threshold, so the decimal is dropped as noise.
    expect(formatBytes('49392123456')).toBe('46 GB');
    expect(formatBytes(4.6 * 1024 ** 3)).toBe('4.6 GB');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536 * 1024 * 1024 * 1024)).toBe('1.5 TB');
  });

  it('drops the decimal above ten, where it is noise', () => {
    expect(formatBytes(46 * 1024 * 1024 * 1024)).toBe('46 GB');
  });

  it('shows a dash rather than "0 B" for nothing', () => {
    expect(formatBytes('0')).toBe('—');
    expect(formatBytes('not a number')).toBe('—');
  });
});

describe('aggregateReasons', () => {
  it('sums across seasons and orders by how much there is', () => {
    // Ordered by count so the biggest job is first.
    expect(aggregateReasons(health())).toEqual([
      { reason: 'missing_subtitles', count: 12 },
      { reason: 'missing_artwork', count: 3 },
      { reason: 'unorganised_path', count: 1 },
    ]);
  });

  it('breaks ties predictably rather than by object order', () => {
    const h = health({ seasons: [
      { seasonNumber: 1, episodes: 2, score: 90, status: 'healthy',
        reasonCounts: { unmatched: 2, duplicate: 2 } },
    ] });
    expect(aggregateReasons(h).map((r) => r.reason)).toEqual(['duplicate', 'unmatched']);
  });

  it('is empty for a clean show', () => {
    expect(aggregateReasons(health({ seasons: [] }))).toEqual([]);
  });
});

describe('ShowOverview', () => {
  it('shows counts, storage and the score', () => {
    render(<ShowOverview health={health()} loading={false} />);
    expect(screen.getByText('2')).toBeInTheDocument();       // seasons
    expect(screen.getByText('12')).toBeInTheDocument();      // episodes
    expect(screen.getByText('46 GB')).toBeInTheDocument();
    expect(screen.getByText('92')).toBeInTheDocument();
  });

  it('lists what to fix, biggest first', () => {
    render(<ShowOverview health={health()} loading={false} />);
    expect(screen.getByText('No subtitles')).toBeInTheDocument();
    expect(screen.getByText('12 · 100%')).toBeInTheDocument();
    expect(screen.getByText('3 · 25%')).toBeInTheDocument();
  });

  it('says so plainly when nothing needs attention', () => {
    render(<ShowOverview health={health({ seasons: [] })} loading={false} />);
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument();
  });

  it('shows a dash for an unscored show', () => {
    // "Not scored" is not "zero health".
    render(<ShowOverview health={health({ score: 0, status: 'unknown' })} loading={false} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders skeletons rather than zeros while loading', () => {
    // Zeros would read as real values for a moment.
    const { container } = render(<ShowOverview health={null} loading />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.h-20').length).toBeGreaterThan(0);
  });

  it('omits watch and play figures entirely', () => {
    /*
     * media_playback_aggregates is empty and MediaUserWatch has no FK to a media
     * item, so rendering these as 0 would report "never watched" for a show
     * someone has watched. An absent figure is better than a false one.
     */
    render(<ShowOverview health={health()} loading={false} />);
    for (const label of ['Watched', 'Plays', 'Completion']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });
});
