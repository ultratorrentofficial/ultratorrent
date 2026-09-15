import { normalizeOwnedQuality, representativeQuality, type QualitySourceFile } from './owned-quality';

/**
 * Owned-media normalization.
 *
 * The rules under test are provenance rules, not arithmetic: a measurement
 * outranks a filename guess, an unmeasured field stays null rather than
 * becoming a zero or a false, and the choice of which file represents an item
 * is deterministic rather than "whichever row the database returned first".
 */

const probed = (over: Partial<QualitySourceFile> = {}): QualitySourceFile => ({
  techSource: 'probe',
  probedAt: new Date('2026-09-01T00:00:00.000Z'),
  width: 1920,
  height: 1080,
  videoCodec: 'x265',
  videoBitDepth: 8,
  chromaSubsampling: '4:2:0',
  audioCodec: 'e-ac-3',
  audioChannels: 6,
  bitrateKbps: 4200,
  container: 'mkv',
  size: 900_000_000,
  ...over,
});

describe('normalizeOwnedQuality — provenance', () => {
  it('marks a probed file as measured and classifies from pixels', () => {
    const q = normalizeOwnedQuality(probed());
    expect(q.provenance).toBe('measured');
    expect(q.resolutionClass).toBe('1080p');
    expect(q.resolutionOrdinal).not.toBeNull();
  });

  it('marks a filename-parsed row as inferred and refuses to use its guess', () => {
    const q = normalizeOwnedQuality({
      techSource: 'filename',
      probedAt: null,
      resolution: '1080p',
      videoCodec: 'x264',
      size: 700_000_000,
    });
    expect(q.provenance).toBe('inferred');
    // The stored label is a guess; it must not become a measured class.
    expect(q.resolutionClass).toBeNull();
    expect(q.videoCodec).toBeNull();
    // Size is a filesystem fact and survives regardless.
    expect(q.sizeBytes).toBe(700_000_000);
  });

  it('marks a never-touched row as unknown', () => {
    expect(normalizeOwnedQuality({ techSource: null, probedAt: null }).provenance).toBe('unknown');
  });

  it('classifies a scope-framed 1080p master by width, not height', () => {
    // 1920x800 is a 2.39:1 crop of a 1080p master; height alone says 720p.
    const q = normalizeOwnedQuality(probed({ width: 1920, height: 800 }));
    expect(q.resolutionClass).toBe('1080p');
  });
});

describe('normalizeOwnedQuality — HDR has three answers, not two', () => {
  it('reports HDR when the probe measured a format', () => {
    expect(normalizeOwnedQuality(probed({ hdrFormat: 'Dolby Vision' })).hdr).toBe(true);
  });

  it('reports SDR when colour was measured and no HDR format was present', () => {
    // videoBitDepth/chroma prove the probe DID read colour on this pass.
    expect(normalizeOwnedQuality(probed({ hdrFormat: null, videoBitDepth: 8 })).hdr).toBe(false);
  });

  it('reports UNKNOWN when the probe never extracted colour at all', () => {
    // The older probe pass in this installation: width/height/bitrate present,
    // every colour field absent. Absence here is not evidence of SDR.
    const q = normalizeOwnedQuality(
      probed({ hdrFormat: null, hdr: null, videoBitDepth: null, chromaSubsampling: null }),
    );
    expect(q.hdr).toBeNull();
  });

  it('never turns an unmeasured codec into a value', () => {
    expect(normalizeOwnedQuality(probed({ videoCodec: null })).videoCodec).toBeNull();
  });
});

describe('representativeQuality — deterministic version choice', () => {
  it('returns nothing for an item with no files', () => {
    const r = representativeQuality([]);
    expect(r.quality).toBeNull();
    expect(r.totalCount).toBe(0);
  });

  it('prefers the highest measured resolution when several versions exist', () => {
    const r = representativeQuality([
      probed({ width: 1280, height: 720, size: 500_000_000 }),
      probed({ width: 3840, height: 2160, size: 8_000_000_000 }),
    ]);
    expect(r.quality?.resolutionClass).toBe('2160p');
    expect(r.multipleVersions).toBe(true);
    expect(r.measuredCount).toBe(2);
  });

  it('breaks a resolution tie by size', () => {
    const r = representativeQuality([
      probed({ size: 700_000_000 }),
      probed({ size: 2_000_000_000 }),
    ]);
    expect(r.quality?.sizeBytes).toBe(2_000_000_000);
    // Same class twice is not "multiple versions" worth flagging.
    expect(r.multipleVersions).toBe(false);
  });

  it('prefers a measured file over an unmeasured one even if larger', () => {
    const r = representativeQuality([
      { techSource: null, probedAt: null, size: 9_000_000_000 },
      probed({ size: 900_000_000 }),
    ]);
    expect(r.quality?.provenance).toBe('measured');
    expect(r.measuredCount).toBe(1);
    expect(r.totalCount).toBe(2);
  });

  it('still reports something when nothing was measured', () => {
    const r = representativeQuality([{ techSource: 'filename', probedAt: null, size: 100 }]);
    expect(r.quality?.provenance).toBe('inferred');
    expect(r.measuredCount).toBe(0);
  });
});
