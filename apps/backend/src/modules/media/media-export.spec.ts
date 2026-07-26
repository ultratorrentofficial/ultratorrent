import { MediaExportService } from './media-export.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1', title: 'Dune', year: 2021, mediaType: 'movie', season: null, episode: null,
  matchStatus: 'matched', confidence: 0.98, locked: false, createdAt: new Date('2026-01-01T00:00:00Z'),
  files: [{ resolution: '2160p', videoCodec: 'HEVC', hdr: 'HDR10', container: 'mkv', size: 12n }],
  _count: { artwork: 2, subtitles: 3 },
  ...over,
});

describe('MediaExportService.escape', () => {
  const esc = MediaExportService.escape;

  it('leaves plain values alone', () => {
    expect(esc('Dune')).toBe('Dune');
    expect(esc(2021)).toBe('2021');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(esc('He said "hi"')).toBe('"He said ""hi"""');
  });

  it('quotes separators and newlines', () => {
    expect(esc('Dune, Part Two')).toBe('"Dune, Part Two"');
    expect(esc('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection', () => {
    // A media title is arbitrary text from a filename or a provider. A cell
    // starting with = is executed as a formula when the file is opened.
    for (const evil of ['=cmd|calc', '+1+1', '-2+3', '@SUM(A1)']) {
      const out = esc(evil);
      expect(out.startsWith("'")).toBe(true);
      expect(out.slice(1)).toBe(evil);
    }
  });

  it('still quotes a formula that also contains a comma', () => {
    expect(esc('=A1,B1')).toBe(`"'=A1,B1"`);
  });

  it('renders empties and booleans predictably', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(true)).toBe('true');
    expect(esc(false)).toBe('false');
  });
});

describe('MediaExportService.streamCsv', () => {
  const build = (pages: unknown[][]) => {
    const calls: any[] = [];
    let i = 0;
    const prisma: any = {
      mediaItem: {
        findMany: jest.fn(async (args: any) => {
          calls.push(args);
          return pages[i++] ?? [];
        }),
      },
    };
    const audits: any[] = [];
    const audit: any = { record: jest.fn(async (e: any) => { audits.push(e); }) };
    return { svc: new MediaExportService(prisma, audit), calls, audits };
  };

  const drain = async (gen: AsyncGenerator<string>) => {
    let out = '';
    for await (const chunk of gen) out += chunk;
    return out;
  };

  it('emits a header even for an empty library', async () => {
    const { svc } = build([[]]);
    const csv = await drain(svc.streamCsv({}, {}));
    expect(csv.split('\r\n')[0]).toContain('id,title,year,mediaType');
    expect(csv.trim().split('\r\n')).toHaveLength(1);
  });

  it('writes one line per item, flattening the first file', async () => {
    const { svc } = build([[row()]]);
    const csv = await drain(svc.streamCsv({}, {}));
    const line = csv.split('\r\n')[1];
    expect(line).toContain('Dune');
    expect(line).toContain('2160p');
    expect(line).toContain('HEVC');
    // Artwork presence is a boolean, subtitles a count.
    expect(line).toContain('true,3');
  });

  it('pages with a keyset cursor rather than an offset', async () => {
    // OFFSET deep into a large table makes Postgres walk every skipped row, and
    // is unstable under concurrent inserts. A FULL page is what triggers the
    // next query — a short one already proves the end.
    const full = Array.from({ length: 1000 }, (_, i) => row({ id: `i${String(i).padStart(4, '0')}` }));
    const { svc, calls } = build([full, []]);
    await drain(svc.streamCsv({}, {}));
    expect(calls[0].skip).toBeUndefined();
    expect(calls[0].orderBy).toEqual({ id: 'asc' });
    // Continues from the last id of the previous page, not an offset.
    expect(calls[1].where.id).toEqual({ gt: 'i0999' });
  });

  it('stops once a short page proves the end', async () => {
    const { svc, calls } = build([[row()], [row({ id: 'x' })]]);
    await drain(svc.streamCsv({}, {}));
    // One under-full page means no further query is worth making.
    expect(calls).toHaveLength(1);
  });

  it('applies the browser filters, so an export cannot cover more than the view', async () => {
    const { svc, calls } = build([[]]);
    await drain(svc.streamCsv(
      { libraryId: 'lib', matchStatus: 'unmatched', search: 'dune' }, {},
    ));
    expect(calls[0].where).toMatchObject({
      libraryId: 'lib',
      matchStatus: 'unmatched',
      title: { contains: 'dune', mode: 'insensitive' },
    });
  });

  it('ignores a whitespace-only search rather than matching nothing', async () => {
    const { svc, calls } = build([[]]);
    await drain(svc.streamCsv({ search: '   ' }, {}));
    expect(calls[0].where.title).toBeUndefined();
  });

  it('audits the export with the row count that actually left', async () => {
    const { svc, audits } = build([[row({ id: 'a' }), row({ id: 'b' })]]);
    await drain(svc.streamCsv({ libraryId: 'lib' }, { userId: 'u1' }));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: 'u1', action: 'media.export.csv', objectType: 'media_library', objectId: 'lib',
    });
    expect(audits[0].metadata.rows).toBe(2);
  });

  it('does not audit until the stream has been consumed', async () => {
    // A generator that is created and abandoned exported nothing.
    const { svc, audits } = build([[row()]]);
    svc.streamCsv({}, {});
    await new Promise((r) => setImmediate(r));
    expect(audits).toHaveLength(0);
  });

  it('escapes a hostile title on the way out', async () => {
    const { svc } = build([[row({ title: '=cmd|calc' })]]);
    const csv = await drain(svc.streamCsv({}, {}));
    expect(csv).toContain("'=cmd|calc");
    expect(csv).not.toMatch(/,=cmd/);
  });
});
