import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@/i18n';
import {
  BrowserFilterBar,
  EMPTY_FILTERS,
  SEARCH_DEBOUNCE_MS,
  hasActiveFilters,
} from './BrowserFilterBar';

afterEach(() => vi.useRealTimers());

describe('hasActiveFilters', () => {
  it('is false for the empty state', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('ignores whitespace-only search', () => {
    // Otherwise a stray space shows a "Clear filters" button that clears nothing.
    expect(hasActiveFilters({ search: '   ', matchStatus: null, issue: null })).toBe(false);
  });

  it('is true for a real search or a status', () => {
    expect(hasActiveFilters({ search: 'dune', matchStatus: null, issue: null })).toBe(true);
    expect(hasActiveFilters({ search: '', matchStatus: 'unmatched', issue: null })).toBe(true);
  });
});

describe('BrowserFilterBar', () => {
  it('debounces typing rather than querying per keystroke', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<BrowserFilterBar value={EMPTY_FILTERS} onChange={onChange} />);

    const box = screen.getByLabelText('Search this library');
    fireEvent.change(box, { target: { value: 'd' } });
    fireEvent.change(box, { target: { value: 'du' } });
    fireEvent.change(box, { target: { value: 'dune' } });
    // Each change is a round trip and a full list reset.
    expect(onChange).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ search: 'dune', matchStatus: null, issue: null });
  });

  it('toggles a status on and off', () => {
    const onChange = vi.fn();
    const { rerender } = render(<BrowserFilterBar value={EMPTY_FILTERS} onChange={onChange} />);
    fireEvent.click(screen.getByText('Unmatched'));
    expect(onChange).toHaveBeenCalledWith({ search: '', matchStatus: 'unmatched', issue: null });

    rerender(
      <BrowserFilterBar value={{ search: '', matchStatus: 'unmatched', issue: null }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Unmatched'));
    expect(onChange).toHaveBeenLastCalledWith({ search: '', matchStatus: null, issue: null });
  });

  it('replaces rather than accumulates statuses', () => {
    // The server takes one matchStatus; letting two look selected would lie.
    const onChange = vi.fn();
    render(
      <BrowserFilterBar value={{ search: '', matchStatus: 'unmatched', issue: null }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Matched'));
    expect(onChange).toHaveBeenCalledWith({ search: '', matchStatus: 'matched', issue: null });
  });

  it('marks the active status for assistive tech', () => {
    render(<BrowserFilterBar value={{ search: '', matchStatus: 'manual', issue: null }} onChange={vi.fn()} />);
    expect(screen.getByText('Manual')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Matched')).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers a clear only when something is active', () => {
    const { rerender } = render(<BrowserFilterBar value={EMPTY_FILTERS} onChange={vi.fn()} />);
    expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();
    rerender(<BrowserFilterBar value={{ search: 'x', matchStatus: null, issue: null }} onChange={vi.fn()} />);
    expect(screen.getByText('Clear filters')).toBeInTheDocument();
  });

  it('clears everything at once', () => {
    const onChange = vi.fn();
    render(
      <BrowserFilterBar value={{ search: 'dune', matchStatus: 'matched', issue: null }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Clear filters'));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTERS);
  });

  it('follows an external reset', () => {
    // The page clears filters on library switch; the box must not keep the text.
    const { rerender } = render(
      <BrowserFilterBar value={{ search: 'dune', matchStatus: null, issue: null }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('Search this library')).toHaveValue('dune');
    rerender(<BrowserFilterBar value={EMPTY_FILTERS} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Search this library')).toHaveValue('');
  });

  describe('issue chips', () => {
    const counts = { unmatched: 3, missing_artwork: 12, missing_subtitles: 0, duplicate: 1 };

    it('shows a chip per issue the library actually has', () => {
      render(<BrowserFilterBar value={EMPTY_FILTERS} onChange={vi.fn()} issueCounts={counts} />);
      expect(screen.getByText('No artwork')).toBeInTheDocument();
      expect(screen.getByText('Duplicate')).toBeInTheDocument();
      // Zero is hidden, not disabled: a list of problems the library does not
      // have is noise, and the absence is the good news.
      expect(screen.queryByText('No subtitles')).not.toBeInTheDocument();
    });

    it('renders nothing when counts have not loaded', () => {
      render(<BrowserFilterBar value={EMPTY_FILTERS} onChange={vi.fn()} />);
      expect(screen.queryByText('No artwork')).not.toBeInTheDocument();
    });

    it('carries the count beside the label', () => {
      render(<BrowserFilterBar value={EMPTY_FILTERS} onChange={vi.fn()} issueCounts={counts} />);
      expect(screen.getByText('No artwork').textContent).toContain('12');
    });

    it('selects and clears an issue', () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <BrowserFilterBar value={EMPTY_FILTERS} onChange={onChange} issueCounts={counts} />,
      );
      fireEvent.click(screen.getByText('No artwork'));
      expect(onChange).toHaveBeenCalledWith({ search: '', matchStatus: null, issue: 'missing_artwork' });

      rerender(
        <BrowserFilterBar
          value={{ search: '', matchStatus: null, issue: 'missing_artwork' }}
          onChange={onChange}
          issueCounts={counts}
        />,
      );
      fireEvent.click(screen.getByText('No artwork'));
      expect(onChange).toHaveBeenLastCalledWith({ search: '', matchStatus: null, issue: null });
    });

    it('counts an issue as an active filter', () => {
      render(
        <BrowserFilterBar
          value={{ search: '', matchStatus: null, issue: 'duplicate' }}
          onChange={vi.fn()}
          issueCounts={counts}
        />,
      );
      expect(screen.getByText('Clear filters')).toBeInTheDocument();
    });
  });

  it('does not re-emit the value it was given', () => {
    // Without the guard the debounce fires on mount and resets paging for nothing.
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<BrowserFilterBar value={{ search: 'dune', matchStatus: null, issue: null }} onChange={onChange} />);
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2); });
    expect(onChange).not.toHaveBeenCalled();
  });
});
