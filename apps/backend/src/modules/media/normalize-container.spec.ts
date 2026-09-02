import { normalizeContainer } from './media-server-provider';

/**
 * Jellyfin and Emby pass ffprobe's `format_name` straight through. For anything
 * in the MP4 family that is the entire demuxer alias list, which reached the UI
 * verbatim: a session chip read "MOV,MP4,M4A,3GP,3G2,MJ2".
 */
describe('normalizeContainer', () => {
  it('picks the recognisable name out of the mp4 demuxer list', () => {
    expect(normalizeContainer('mov,mp4,m4a,3gp,3g2,mj2')).toBe('mp4');
  });

  it('calls matroska mkv, which is what the file is named', () => {
    expect(normalizeContainer('matroska,webm')).toBe('mkv');
    expect(normalizeContainer('matroska')).toBe('mkv');
  });

  it('leaves a single value alone — Plex already reports one', () => {
    expect(normalizeContainer('mkv')).toBe('mkv');
    expect(normalizeContainer('avi')).toBe('avi');
  });

  it('falls back to the first entry for a list it does not know', () => {
    expect(normalizeContainer('weirdfmt,otherfmt')).toBe('weirdfmt');
  });

  it('treats missing or blank as absent rather than an empty chip', () => {
    expect(normalizeContainer(null)).toBeUndefined();
    expect(normalizeContainer(undefined)).toBeUndefined();
    expect(normalizeContainer('   ')).toBeUndefined();
    expect(normalizeContainer(',,')).toBeUndefined();
  });

  it('tolerates whitespace and case in the list', () => {
    expect(normalizeContainer('MOV, MP4 , M4A')).toBe('mp4');
  });
});
