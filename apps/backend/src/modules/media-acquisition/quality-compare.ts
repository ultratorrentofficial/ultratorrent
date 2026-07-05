import { parseTorrentName } from '../rss/torrent-name-parser';

/**
 * Multi-dimensional release quality comparison for upgrade intelligence. Ranks a
 * candidate release against an owned one across resolution, source, HDR (Dolby
 * Vision > HDR10+ > HDR10 > HLG > SDR), audio (Atmos/DTS:X > lossless > lossy)
 * and channels, plus a small codec-efficiency tiebreak. Pure and deterministic —
 * it parses the release *names* (the only signal available for an owned torrent),
 * so it never touches IO. Bitrate is intentionally excluded: it is not reliably
 * encoded in release names.
 */

export interface QualityScore {
  resolution: number;
  source: number;
  hdr: number;
  audio: number;
  channels: number;
  codec: number;
  total: number;
  labels: Record<string, string>;
}

export interface QualityComparison {
  /** True when the candidate is strictly higher quality than the owned release. */
  better: boolean;
  candidate: QualityScore;
  owned: QualityScore;
  /** Dimensions where the candidate wins, e.g. "resolution 2160p > 1080p". */
  reasons: string[];
}

const RES: Record<string, number> = { '2160p': 4, '4k': 4, '1080p': 3, '720p': 2, '576p': 1, '480p': 1 };

function rankResolution(res: string | null): [number, string] {
  if (!res) return [0, 'unknown'];
  return [RES[res.toLowerCase()] ?? 0, res];
}

function rankSource(source: string | null): [number, string] {
  const s = (source ?? '').toLowerCase();
  if (/remux/.test(s)) return [5, 'Remux'];
  if (/blu-?ray|bd/.test(s)) return [4, 'BluRay'];
  if (/web-?dl/.test(s)) return [3, 'WEB-DL'];
  if (/web-?rip|web/.test(s)) return [2, 'WEBRip'];
  if (/hdtv|dvd|sdtv/.test(s)) return [1, s.toUpperCase()];
  return [0, source ?? 'unknown'];
}

function rankHdr(hdr: string[]): [number, string] {
  const joined = hdr.join(' ').toLowerCase();
  if (/dolby ?vision|dovi|\bdv\b/.test(joined)) return [4, 'Dolby Vision'];
  if (/hdr10\+|hdr10plus/.test(joined)) return [3, 'HDR10+'];
  if (/hdr10|hdr/.test(joined)) return [2, 'HDR10'];
  if (/hlg/.test(joined)) return [1, 'HLG'];
  return [0, 'SDR'];
}

function rankAudio(audio: string[]): [number, string] {
  const joined = audio.join(' ').toLowerCase();
  if (/atmos/.test(joined)) return [5, 'Atmos'];
  if (/dts[-: ]?x/.test(joined)) return [5, 'DTS:X'];
  if (/truehd/.test(joined)) return [4, 'TrueHD'];
  if (/dts[-: ]?hd/.test(joined)) return [4, 'DTS-HD'];
  if (/e-?ac-?3|dd\+|ddp|dolby ?digital ?plus/.test(joined)) return [3, 'DD+'];
  if (/\bdts\b|ac-?3|\bdd\b|dolby ?digital/.test(joined)) return [2, 'DTS/DD'];
  if (/aac|opus|mp3/.test(joined)) return [1, 'AAC'];
  return [0, 'unknown'];
}

function rankChannels(title: string): [number, string] {
  if (/\b7\.1\b/.test(title)) return [3, '7.1'];
  if (/\b5\.1\b/.test(title)) return [2, '5.1'];
  if (/\b2\.0\b|\bstereo\b/i.test(title)) return [1, '2.0'];
  return [0, 'unknown'];
}

function rankCodec(codec: string | null): [number, string] {
  const c = (codec ?? '').toLowerCase();
  if (/av1/.test(c)) return [2, 'AV1'];
  if (/x?265|hevc/.test(c)) return [1, 'HEVC'];
  if (/x?264|avc/.test(c)) return [0, 'AVC'];
  return [0, codec ?? 'unknown'];
}

// Weights: resolution dominates, then source, HDR, audio, channels, codec (tiebreak).
const W = { resolution: 1000, source: 100, hdr: 50, audio: 10, channels: 5, codec: 1 };

export function scoreQuality(title: string): QualityScore {
  const meta = parseTorrentName(title);
  const [resolution, resLabel] = rankResolution(meta.resolution);
  const [source, srcLabel] = rankSource(meta.source);
  const [hdr, hdrLabel] = rankHdr(meta.hdr ?? []);
  const [audio, audioLabel] = rankAudio(meta.audio ?? []);
  const [channels] = rankChannels(title);
  const [codec] = rankCodec(meta.codec);
  const total =
    resolution * W.resolution +
    source * W.source +
    hdr * W.hdr +
    audio * W.audio +
    channels * W.channels +
    codec * W.codec;
  return {
    resolution,
    source,
    hdr,
    audio,
    channels,
    codec,
    total,
    labels: { resolution: resLabel, source: srcLabel, hdr: hdrLabel, audio: audioLabel },
  };
}

export function compareQuality(candidateTitle: string, ownedTitle: string): QualityComparison {
  const candidate = scoreQuality(candidateTitle);
  const owned = scoreQuality(ownedTitle);
  const reasons: string[] = [];
  const dims: [keyof QualityScore, string][] = [
    ['resolution', 'resolution'],
    ['source', 'source'],
    ['hdr', 'HDR'],
    ['audio', 'audio'],
    ['channels', 'channels'],
  ];
  for (const [key, label] of dims) {
    if ((candidate[key] as number) > (owned[key] as number)) {
      const cl = candidate.labels[key] ?? String(candidate[key]);
      const ol = owned.labels[key] ?? String(owned[key]);
      reasons.push(`${label} ${cl} > ${ol}`);
    }
  }
  // A codec change alone (e.g. x264 → x265) is an efficiency difference, not a
  // quality upgrade — it should not trigger a re-download. So `better` weighs
  // only the real quality dimensions; codec stays in `total` for ranking/display.
  const qualityTotal = (q: QualityScore) => q.total - q.codec * W.codec;
  return { better: qualityTotal(candidate) > qualityTotal(owned), candidate, owned, reasons };
}
