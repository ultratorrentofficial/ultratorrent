import { parseMediaInfo, resolutionFromHeight } from './media-probe.service';

/** A real `mediainfo --Output=JSON` shape, trimmed to the fields we read. */
const mediaInfo = (over: {
  general?: Record<string, unknown>;
  video?: Record<string, unknown>;
  audio?: Record<string, unknown> | null;
}) => ({
  media: {
    track: [
      { '@type': 'General', Format: 'Matroska', Duration: '2536.341', OverallBitRate: '1094978', ...over.general },
      { '@type': 'Video', Format: 'HEVC', Width: '1920', Height: '1080', FrameRate: '23.976', ...over.video },
      ...(over.audio === null ? [] : [{ '@type': 'Audio', Format: 'AAC', Channels: '6', ...over.audio }]),
    ],
  },
});

describe('parseMediaInfo', () => {
  it('reads what the container actually says', () => {
    const t = parseMediaInfo(mediaInfo({}));
    expect(t).toMatchObject({
      container: 'matroska',
      videoCodec: 'x265',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      audioChannels: 6,
      resolution: '1080p',
      bitrateKbps: 1095, // 1_094_978 bps → kbps
      durationSec: 2536,
      frameRate: 23.976,
    });
  });

  it('normalises codec names to the tokens the match-engine already speaks', () => {
    const codec = (Format: string) => parseMediaInfo(mediaInfo({ video: { Format } })).videoCodec;
    expect(codec('HEVC')).toBe('x265');
    expect(codec('AVC')).toBe('x264');
    expect(codec('V_MPEGH/ISO/HEVC')).toBe('x265');
    expect(codec('AV1')).toBe('av1');
    expect(codec('MPEG-4 Visual')).toBe('xvid');
  });

  it('prefers the container overall bitrate over the video track alone', () => {
    // A video-track bitrate omits audio; the overall figure is the useful one.
    const t = parseMediaInfo(
      mediaInfo({ general: { OverallBitRate: '5000000' }, video: { BitRate: '4000000' } }),
    );
    expect(t.bitrateKbps).toBe(5000);
  });

  it('falls back to the video bitrate when the container reports none', () => {
    const t = parseMediaInfo(
      mediaInfo({ general: { OverallBitRate: undefined }, video: { BitRate: '800340' } }),
    );
    expect(t.bitrateKbps).toBe(800);
  });

  it('reports HDR only when the container actually carries it', () => {
    expect(parseMediaInfo(mediaInfo({})).hdr).toBeUndefined(); // SDR → absent, not "SDR"
    expect(parseMediaInfo(mediaInfo({ video: { HDR_Format: 'Dolby Vision / SMPTE ST 2086' } })).hdr)
      .toBe('Dolby Vision');
  });

  it('omits fields it did not learn, rather than nulling them', () => {
    // Spread over a DB row, an absent key must not wipe a column.
    const t = parseMediaInfo(mediaInfo({ audio: null, video: { FrameRate: undefined } }));
    expect('audioChannels' in t).toBe(false);
    expect('frameRate' in t).toBe(false);
    expect(t.videoCodec).toBe('x265'); // what it DID learn survives
  });

  it('survives a container with no tracks', () => {
    expect(parseMediaInfo({ media: { track: [] } })).toEqual({});
    expect(parseMediaInfo({})).toEqual({});
    expect(parseMediaInfo(null)).toEqual({});
  });
});

describe('resolutionFromHeight', () => {
  it('bands real-world letterboxed frames to the tier they were mastered at', () => {
    // The whole point: a 1080p release is rarely 1920x1080 on disk.
    expect(resolutionFromHeight(1080, 1920)).toBe('1080p');
    expect(resolutionFromHeight(804, 1920)).toBe('1080p'); // 2.39:1 scope — the Masters of the Universe file
    expect(resolutionFromHeight(720, 1280)).toBe('720p');
    expect(resolutionFromHeight(2160, 3840)).toBe('2160p');
  });

  it('calls the library’s SD rips what they are', () => {
    // Measured in the real library: these are NOT 720p, despite the 720 width.
    expect(resolutionFromHeight(404, 720)).toBe('480p');
    expect(resolutionFromHeight(400, 720)).toBe('480p');
    expect(resolutionFromHeight(480, 852)).toBe('480p');
  });

  it('returns undefined when it knows nothing', () => {
    expect(resolutionFromHeight(undefined, undefined)).toBeUndefined();
  });
});
