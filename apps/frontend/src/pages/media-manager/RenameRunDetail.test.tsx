import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/i18n';

const detail = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => detail.value }));
vi.mock('@/lib/api', () => ({ api: { media: { renameRunOperations: vi.fn() } } }));

import { RenameRunDetail } from './RenameRunDetail';

const ok = (operations: unknown[], over: Record<string, unknown> = {}) => ({
  isLoading: false,
  isError: false,
  data: { total: operations.length, truncated: false, operations, ...over },
});
const op = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  source: '/media/TV/Show/old.name.s01e01.mkv',
  destination: '/media/TV/Show/Show - S01E01.mkv',
  action: 'move', kind: 'video', status: 'success', message: null, undoneAt: null,
  ...over,
});

beforeEach(() => {
  detail.value = ok([op()]);
});

/**
 * Reported as: the undo list shows the events but not the original name or the
 * change, "so there's no way to analyze it". The paths were recorded on every
 * operation from the start — only the display was missing.
 */
describe('RenameRunDetail', () => {
  it('shows the old and the new name', () => {
    render(<RenameRunDetail runId="r1" />);
    expect(screen.getByText('old.name.s01e01.mkv')).toBeInTheDocument();
    expect(screen.getByText('Show - S01E01.mkv')).toBeInTheDocument();
  });

  it('separates the basename from its directory', () => {
    /*
     * The readability property. Two full absolute paths differing in one
     * segment bury the change; the name is emphasised and the directory
     * demoted, so the difference sits where the eye already is.
     */
    render(<RenameRunDetail runId="r1" />);
    expect(screen.getAllByText('/media/TV/Show')).toHaveLength(2);
    expect(screen.queryByText('/media/TV/Show/old.name.s01e01.mkv')).not.toBeInTheDocument();
  });

  it('shows a move across directories on both sides', () => {
    detail.value = ok([op({ destination: '/media/Movies/Sorted/Show - S01E01.mkv' })]);
    render(<RenameRunDetail runId="r1" />);
    expect(screen.getByText('/media/TV/Show')).toBeInTheDocument();
    expect(screen.getByText('/media/Movies/Sorted')).toBeInTheDocument();
  });

  it('renders an em dash when there is no destination', () => {
    // A delete or a skip; an empty cell reads as a rendering bug.
    detail.value = ok([op({ destination: null, action: 'delete' })]);
    render(<RenameRunDetail runId="r1" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('labels only the exceptions, not every successful row', () => {
    detail.value = ok([op(), op({ id: 'o2', status: 'failed', message: 'permission denied' })]);
    render(<RenameRunDetail runId="r1" />);
    expect(screen.getByText(/failed · permission denied/)).toBeInTheDocument();
    expect(screen.queryByText(/^success$/)).not.toBeInTheDocument();
  });

  it('marks an operation that was already undone', () => {
    detail.value = ok([op({ undoneAt: '2026-07-30T10:00:00Z' })]);
    render(<RenameRunDetail runId="r1" />);
    expect(screen.getByText('Already undone')).toBeInTheDocument();
  });

  it('says when the list is only part of the run', () => {
    // A capped list that reads as complete is worse than no list.
    detail.value = ok([op()], { truncated: true, total: 900 });
    render(<RenameRunDetail runId="r1" />);
    expect(screen.getByText(/Showing 1 of 900 files/)).toBeInTheDocument();
  });

  it('reports a failed load rather than rendering an empty run', () => {
    detail.value = { isLoading: false, isError: true, data: undefined };
    render(<RenameRunDetail runId="r1" />);
    expect(screen.getByText(/Could not load/)).toBeInTheDocument();
  });
});
