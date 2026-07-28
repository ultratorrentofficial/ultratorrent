import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@/i18n';
import { AlphabetRail } from './AlphabetRail';

const LETTERS = ['#', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))];

/** A full 27-entry rail, with only the named letters populated. */
const railWith = (populated: Record<string, number>) =>
  LETTERS.map((letter) => ({ letter, count: populated[letter] ?? 0 }));

describe('AlphabetRail', () => {
  it('renders every letter, including the empty ones', () => {
    // A rail that dropped its gaps would change length as a library grows, and
    // moving targets are worse than dim ones.
    render(<AlphabetRail entries={railWith({ A: 3, M: 1 })} active={null} onJump={vi.fn()} />);
    for (const letter of ['A', 'M', 'Q', 'Z', '#']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${letter === '#' ? '#' : letter} `) }))
        .toBeInTheDocument();
    }
  });

  it('disables a letter with nothing under it', () => {
    render(<AlphabetRail entries={railWith({ A: 3 })} active={null} onJump={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^A / })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^B / })).toBeDisabled();
  });

  it('puts the count in the accessible name, not only the colour', () => {
    // "Greyed out" is not information a screen reader receives.
    render(<AlphabetRail entries={railWith({ M: 12 })} active={null} onJump={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'M — 12 titles' })).toBeInTheDocument();
  });

  it('reports a single title in the singular', () => {
    render(<AlphabetRail entries={railWith({ M: 1 })} active={null} onJump={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'M — 1 title' })).toBeInTheDocument();
  });

  it('jumps to the letter pressed', () => {
    const onJump = vi.fn();
    render(<AlphabetRail entries={railWith({ M: 4 })} active={null} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: /^M / }));
    expect(onJump).toHaveBeenCalledWith('M');
  });

  it('does not jump to an empty letter', () => {
    const onJump = vi.fn();
    render(<AlphabetRail entries={railWith({ A: 1 })} active={null} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: /^B / }));
    expect(onJump).not.toHaveBeenCalled();
  });

  it('offers a way back to the top', () => {
    /*
     * The rail anchors rather than filters, and an anchor is one-way — you
     * cannot scroll above it. Without "All" the reader is stuck at whatever
     * letter they last pressed.
     */
    const onJump = vi.fn();
    render(<AlphabetRail entries={railWith({ M: 2 })} active="M" onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onJump).toHaveBeenCalledWith(null);
  });

  it('marks the anchored letter as current', () => {
    render(<AlphabetRail entries={railWith({ M: 2, A: 1 })} active="M" onJump={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^M / })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /^A / })).not.toHaveAttribute('aria-current');
  });

  it('renders nothing at all when the aggregate has not arrived', () => {
    // Not an empty rail: 27 dead buttons before the counts load would be worse
    // than no rail for that moment.
    const { container } = render(<AlphabetRail entries={[]} active={null} onJump={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
