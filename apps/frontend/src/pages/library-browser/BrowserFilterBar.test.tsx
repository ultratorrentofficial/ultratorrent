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
    expect(hasActiveFilters({ search: '   ', matchStatus: null })).toBe(false);
  });

  it('is true for a real search or a status', () => {
    expect(hasActiveFilters({ search: 'dune', matchStatus: null })).toBe(true);
    expect(hasActiveFilters({ search: '', matchStatus: 'unmatched' })).toBe(true);
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
    expect(onChange).toHaveBeenCalledWith({ search: 'dune', matchStatus: null });
  });

  it('toggles a status on and off', () => {
    const onChange = vi.fn();
    const { rerender } = render(<BrowserFilterBar value={EMPTY_FILTERS} onChange={onChange} />);
    fireEvent.click(screen.getByText('Unmatched'));
    expect(onChange).toHaveBeenCalledWith({ search: '', matchStatus: 'unmatched' });

    rerender(
      <BrowserFilterBar value={{ search: '', matchStatus: 'unmatched' }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Unmatched'));
    expect(onChange).toHaveBeenLastCalledWith({ search: '', matchStatus: null });
  });

  it('replaces rather than accumulates statuses', () => {
    // The server takes one matchStatus; letting two look selected would lie.
    const onChange = vi.fn();
    render(
      <BrowserFilterBar value={{ search: '', matchStatus: 'unmatched' }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Matched'));
    expect(onChange).toHaveBeenCalledWith({ search: '', matchStatus: 'matched' });
  });

  it('marks the active status for assistive tech', () => {
    render(<BrowserFilterBar value={{ search: '', matchStatus: 'manual' }} onChange={vi.fn()} />);
    expect(screen.getByText('Manual')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Matched')).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers a clear only when something is active', () => {
    const { rerender } = render(<BrowserFilterBar value={EMPTY_FILTERS} onChange={vi.fn()} />);
    expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();
    rerender(<BrowserFilterBar value={{ search: 'x', matchStatus: null }} onChange={vi.fn()} />);
    expect(screen.getByText('Clear filters')).toBeInTheDocument();
  });

  it('clears everything at once', () => {
    const onChange = vi.fn();
    render(
      <BrowserFilterBar value={{ search: 'dune', matchStatus: 'matched' }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Clear filters'));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTERS);
  });

  it('follows an external reset', () => {
    // The page clears filters on library switch; the box must not keep the text.
    const { rerender } = render(
      <BrowserFilterBar value={{ search: 'dune', matchStatus: null }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('Search this library')).toHaveValue('dune');
    rerender(<BrowserFilterBar value={EMPTY_FILTERS} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Search this library')).toHaveValue('');
  });

  it('does not re-emit the value it was given', () => {
    // Without the guard the debounce fires on mount and resets paging for nothing.
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<BrowserFilterBar value={{ search: 'dune', matchStatus: null }} onChange={onChange} />);
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2); });
    expect(onChange).not.toHaveBeenCalled();
  });
});
