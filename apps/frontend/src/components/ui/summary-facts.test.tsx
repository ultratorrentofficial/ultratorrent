import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SummaryFacts, humanizeKey } from './summary-facts';

/**
 * The Jobs Center printed `inputSummary` through `JSON.stringify`, so opening a
 * completed metadata refresh showed a blob containing `"itemId": null,
 * "libraryId": null`. The reasonable reading is "this job has no idea what to
 * work on" — and it was wrong. The job carried its item, and `libraryId` is null
 * BY DESIGN on the bulk path because a selection can span libraries. The data
 * was fine; the presentation asserted a failure that had not happened.
 *
 * These pin the properties that stop it saying that again.
 */
describe('SummaryFacts', () => {
  it('never renders the word null, and omits what is not set', () => {
    // The literal payload behind the complaint.
    render(<SummaryFacts label="Input" value={{ itemId: null, libraryId: null, itemIds: ['abc123'] }} />);
    expect(screen.queryByText(/null/i)).toBeNull();
    // The one thing that IS set still shows.
    expect(screen.getByText('Items')).toBeInTheDocument();
  });

  it('says so plainly when there is genuinely nothing', () => {
    render(<SummaryFacts label="Input" value={{}} emptyText="Nothing was passed in." />);
    expect(screen.getByText('Nothing was passed in.')).toBeInTheDocument();
  });

  it('renders no JSON punctuation — no braces, brackets or quoted keys', () => {
    const { container } = render(
      <SummaryFacts label="Result" value={{ found: 0, created: 2, itemId: 'a1b2c3d4-1111-2222-3333-444455556666' }} />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/[{}[\]]/);
    expect(text).not.toMatch(/"\w+":/);
  });

  it('formats by meaning rather than by type', () => {
    render(
      <SummaryFacts
        label="Result"
        value={{ totalSavingsBytes: 1_500_000, permanent: false, succeeded: 12 }}
      />,
    );
    expect(screen.getByText(/MB|KB/)).toBeInTheDocument();   // bytes as a size
    expect(screen.getByText('No')).toBeInTheDocument();       // boolean as a word
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('summarises a long list instead of printing every id', () => {
    render(<SummaryFacts label="Input" value={{ itemIds: Array.from({ length: 40 }, (_, i) => `id-${i}`) }} />);
    expect(screen.getByText(/^40 — /)).toBeInTheDocument();
  });
});

describe('humanizeKey', () => {
  it.each([
    ['libraryId', 'Library'],
    ['itemIds', 'Items'],
    ['totalSavingsBytes', 'Total savings'],
    ['mediaItemId', 'Media item'],
    ['requiresReview', 'Requires review'],
    ['found', 'Found'],
  ])('%s → %s', (input, expected) => {
    expect(humanizeKey(input)).toBe(expected);
  });
});
