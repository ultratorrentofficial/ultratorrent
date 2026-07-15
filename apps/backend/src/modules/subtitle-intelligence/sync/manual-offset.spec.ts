import { ManualOffsetProvider } from './manual-offset.provider';
import { MAX_BELIEVABLE_OFFSET_MS } from './subtitle-sync-provider';

const srt = '1\n00:00:01,000 --> 00:00:04,000\nHi.\n';

describe('ManualOffsetProvider', () => {
  const p = new ManualOffsetProvider();

  it('is always available (no binary)', async () => {
    expect(await p.isAvailable()).toBe(true);
  });

  it('shifts the subtitle by the requested offset', async () => {
    const r = await p.synchronize({ videoPath: '/x.mkv', content: srt, format: 'srt', offsetMs: 1000 });
    expect(r.method).toBe('offset');
    expect(r.offsetMs).toBe(1000);
    expect(r.content).toContain('00:00:02,000 --> 00:00:05,000');
  });

  it('defaults to a no-op when no offset is given', async () => {
    const r = await p.synchronize({ videoPath: '/x.mkv', content: srt, format: 'srt' });
    expect(r.offsetMs).toBe(0);
    expect(r.content).toContain('00:00:01,000 --> 00:00:04,000');
  });

  it('rejects an implausible offset in validateSync', async () => {
    const good = await p.synchronize({ videoPath: '/x.mkv', content: srt, format: 'srt', offsetMs: 1000 });
    expect(p.validateSync(good)).toBe(true);
    expect(p.validateSync({ ...good, offsetMs: MAX_BELIEVABLE_OFFSET_MS + 1 })).toBe(false);
  });

  it('reports offset/drift estimates', async () => {
    expect(await p.estimateOffset({ videoPath: '/x', content: srt, format: 'srt', offsetMs: 250 })).toBe(250);
    expect(await p.estimateDrift({ videoPath: '/x', content: srt, format: 'srt', driftFactor: 1.05 })).toBe(1.05);
  });
});
