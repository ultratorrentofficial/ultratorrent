import { sidecarPath } from './subtitle-install.service';

describe('sidecarPath', () => {
  const video = '/media/Movies/Movie (2020)/Movie (2020).mkv';

  it('names a plain language sidecar next to the video', () => {
    expect(sidecarPath(video, { language: 'en', format: 'srt' })).toBe('/media/Movies/Movie (2020)/Movie (2020).en.srt');
  });

  it('supports a region tag', () => {
    expect(sidecarPath(video, { language: 'es-PR', format: 'srt' })).toBe('/media/Movies/Movie (2020)/Movie (2020).es-PR.srt');
  });

  it('appends forced then sdh flags in convention order', () => {
    expect(sidecarPath(video, { language: 'en', forced: true, format: 'srt' })).toBe('/media/Movies/Movie (2020)/Movie (2020).en.forced.srt');
    expect(sidecarPath(video, { language: 'en', sdh: true, format: 'srt' })).toBe('/media/Movies/Movie (2020)/Movie (2020).en.sdh.srt');
    expect(sidecarPath(video, { language: 'en', forced: true, sdh: true, format: 'srt' })).toBe('/media/Movies/Movie (2020)/Movie (2020).en.forced.sdh.srt');
  });

  it('honors the subtitle format extension', () => {
    expect(sidecarPath('/tv/Show/S01E01.mkv', { language: 'en', format: 'ass' })).toBe('/tv/Show/S01E01.en.ass');
  });

  it('tolerates a format with a leading dot', () => {
    expect(sidecarPath('/tv/Show/S01E01.mkv', { language: 'en', format: '.vtt' })).toBe('/tv/Show/S01E01.en.vtt');
  });
});
