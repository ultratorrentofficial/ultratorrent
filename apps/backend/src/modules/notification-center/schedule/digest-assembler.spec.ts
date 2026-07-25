import { assembleDigest, renderDigestText, type DigestCandidate } from './digest-assembler';

const at = (iso: string) => new Date(iso);

const item = (over: Partial<DigestCandidate> = {}): DigestCandidate => ({
  id: 'n1', eventKey: 'download.torrent_completed', category: 'downloads',
  severity: 'success', title: 'Torrent completed', groupCount: 1,
  lastAt: at('2026-07-25T10:00:00Z'), ...over,
});

describe('assembleDigest', () => {
  it('reports an empty period as empty', () => {
    const d = assembleDigest([]);
    expect(d).toMatchObject({ isEmpty: true, itemCount: 0, occurrenceCount: 0 });
  });

  it('collapses identical events into one counted line', () => {
    // Two completions are separate notifications — you might open either — but in
    // a summary they are one line reading ×2.
    const d = assembleDigest([item({ id: 'a' }), item({ id: 'b' })]);
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0].lines).toHaveLength(1);
    expect(d.sections[0].lines[0].count).toBe(2);
    expect(d.itemCount).toBe(2);
  });

  it('sums repeats already collapsed at dispatch', () => {
    const d = assembleDigest([item({ groupCount: 3 }), item({ id: 'b', groupCount: 2 })]);
    expect(d.sections[0].lines[0].count).toBe(5);
    expect(d.occurrenceCount).toBe(5);
  });

  it('keeps different events as separate lines', () => {
    const d = assembleDigest([item(), item({ id: 'b', eventKey: 'download.stalled', title: 'Stalled' })]);
    expect(d.sections[0].lines).toHaveLength(2);
  });

  it('groups by category', () => {
    const d = assembleDigest([
      item(),
      item({ id: 'b', category: 'media', eventKey: 'media.renamed', title: 'Renamed' }),
    ]);
    expect(d.sections.map((s) => s.category).sort()).toEqual(['downloads', 'media']);
  });

  it('orders sections worst-severity first, so the digest opens with what matters', () => {
    const d = assembleDigest([
      item({ category: 'downloads', severity: 'success' }),
      item({ id: 'b', category: 'security', severity: 'security', eventKey: 'system.security_alert', title: 'Security alert' }),
      item({ id: 'c', category: 'system', severity: 'warning', eventKey: 'system.cpu_high', title: 'CPU high' }),
    ]);
    expect(d.sections.map((s) => s.category)).toEqual(['security', 'system', 'downloads']);
  });

  it('orders lines within a section by recency', () => {
    const d = assembleDigest([
      item({ eventKey: 'a', title: 'Older', lastAt: at('2026-07-25T08:00:00Z') }),
      item({ id: 'b', eventKey: 'b', title: 'Newer', lastAt: at('2026-07-25T12:00:00Z') }),
    ]);
    expect(d.sections[0].lines.map((l) => l.title)).toEqual(['Newer', 'Older']);
  });

  it('keeps the most recent timestamp when collapsing', () => {
    const d = assembleDigest([
      item({ lastAt: at('2026-07-25T08:00:00Z') }),
      item({ id: 'b', lastAt: at('2026-07-25T14:00:00Z') }),
    ]);
    expect(d.sections[0].lines[0].lastAt.toISOString()).toBe('2026-07-25T14:00:00.000Z');
  });

  it('reports the worst severity present', () => {
    const d = assembleDigest([item({ severity: 'info' }), item({ id: 'b', eventKey: 'x', severity: 'critical' })]);
    expect(d.topSeverity).toBe('critical');
  });

  describe('the cap', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item({ id: `n${i}`, eventKey: `e${i}`, title: `Event ${i}` }));

    it('bounds the rendered lines', () => {
      const d = assembleDigest(many, 10);
      const rendered = d.sections.reduce((n, s) => n + s.lines.length, 0);
      expect(rendered).toBe(10);
    });

    it('REPORTS what it omitted rather than quietly under-stating', () => {
      const d = assembleDigest(many, 10);
      expect(d.overflow).toBe(20);
      expect(d.itemCount).toBe(30); // the true total is still reported
    });

    it('counts lines dropped from a section removed entirely', () => {
      const mixed = [
        ...Array.from({ length: 5 }, (_, i) => item({ id: `d${i}`, eventKey: `d${i}`, severity: 'critical' })),
        ...Array.from({ length: 4 }, (_, i) =>
          item({ id: `m${i}`, eventKey: `m${i}`, category: 'media', severity: 'info' })),
      ];
      const d = assembleDigest(mixed, 5);
      expect(d.overflow).toBe(4);
      expect(d.sections.map((s) => s.category)).toEqual(['downloads']); // media dropped whole
    });
  });
});

describe('renderDigestText', () => {
  it('renders nothing for an empty digest', () => {
    expect(renderDigestText(assembleDigest([]), 'Daily')).toBe('');
  });

  it('renders sections with counted lines', () => {
    const d = assembleDigest([item(), item({ id: 'b' }), item({ id: 'c', eventKey: 'x', title: 'Other' })]);
    const text = renderDigestText(d, 'Daily notification digest');
    expect(text).toContain('Daily notification digest');
    expect(text).toContain('DOWNLOADS');
    expect(text).toContain('Torrent completed ×2');
    expect(text).toContain('Other');
    expect(text).not.toContain('Other ×'); // a single occurrence carries no count
  });

  it('states the omitted count in the body', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ id: `n${i}`, eventKey: `e${i}`, title: `E${i}` }));
    const text = renderDigestText(assembleDigest(many, 5), 'Daily');
    expect(text).toContain('…and 7 more.');
  });
});
