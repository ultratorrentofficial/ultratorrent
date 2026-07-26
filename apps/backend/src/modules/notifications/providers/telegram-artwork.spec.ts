import { MAX_TELEGRAM_PHOTO_BYTES, prepareTelegramPhoto } from './telegram-artwork';

const PNG = (pad = 64) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(pad)]);
const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
const WEBP = () =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);

describe('prepareTelegramPhoto', () => {
  it('accepts the three formats Telegram can render', () => {
    expect(prepareTelegramPhoto({ body: PNG(), contentType: 'image/png' })?.contentType).toBe('image/png');
    expect(prepareTelegramPhoto({ body: JPEG(), contentType: 'image/jpeg' })?.contentType).toBe('image/jpeg');
    expect(prepareTelegramPhoto({ body: WEBP(), contentType: 'image/webp' })?.contentType).toBe('image/webp');
  });

  it('trusts magic bytes over the declared content type', () => {
    // The realistic case: a media server serves an HTML error page and labels it
    // image/png. Uploading that costs a whole delivery attempt.
    const lie = prepareTelegramPhoto({ body: Buffer.from('<html>404</html>'), contentType: 'image/png' });
    expect(lie).toBeNull();

    // And the inverse — real PNG bytes mislabelled — is still accepted, because
    // the bytes are what Telegram decodes.
    const truth = prepareTelegramPhoto({ body: PNG(), contentType: 'application/octet-stream' });
    expect(truth?.contentType).toBe('image/png');
  });

  it('rejects an SVG, which Telegram cannot render as a photo', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(prepareTelegramPhoto({ body: svg, contentType: 'image/svg+xml' })).toBeNull();
  });

  it('rejects an oversized image before the upload is attempted', () => {
    const huge = Buffer.concat([PNG(), Buffer.alloc(MAX_TELEGRAM_PHOTO_BYTES)]);
    expect(prepareTelegramPhoto({ body: huge, contentType: 'image/png' })).toBeNull();
  });

  it('treats missing or empty artwork as no artwork', () => {
    expect(prepareTelegramPhoto(null)).toBeNull();
    expect(prepareTelegramPhoto({ body: Buffer.alloc(0), contentType: 'image/png' })).toBeNull();
  });

  it('never carries the provider path into the filename', () => {
    const photo = prepareTelegramPhoto({ body: JPEG(), contentType: 'image/jpeg' });
    // A fixed, non-identifying name: the real path is provider-internal and must
    // not travel to a third party.
    expect(photo!.filename).toBe('poster.jpg');
  });
});
