import { MEDIA_TICKET_TTL_MS, signMediaTicket, verifyMediaTicket } from './media-ticket';

const SECRET = 'test-secret-value-long-enough';
const NOW = 1_700_000_000_000;

describe('media tickets', () => {
  it('round-trips the path and minting user', () => {
    const { token, expiresAt } = signMediaTicket(SECRET, { p: '/movies/a.mkv', u: 'user-1' }, NOW);
    expect(expiresAt).toBe(NOW + MEDIA_TICKET_TTL_MS);
    expect(verifyMediaTicket(SECRET, token, NOW + 1000)).toMatchObject({
      p: '/movies/a.mkv',
      u: 'user-1',
    });
  });

  it('rejects a ticket signed with a different secret', () => {
    const { token } = signMediaTicket(SECRET, { p: '/a.jpg' }, NOW);
    expect(verifyMediaTicket('other-secret', token, NOW)).toBeNull();
  });

  /* The path is inside the signed body, so re-pointing it invalidates the ticket. */
  it('rejects a ticket whose payload was edited', () => {
    const { token } = signMediaTicket(SECRET, { p: '/a.jpg' }, NOW);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ p: '/etc/shadow', x: NOW + 1e6 })).toString('base64url')}.${sig}`;
    expect(verifyMediaTicket(SECRET, forged, NOW)).toBeNull();
  });

  it('rejects an expired ticket', () => {
    const { token } = signMediaTicket(SECRET, { p: '/a.jpg' }, NOW);
    expect(verifyMediaTicket(SECRET, token, NOW + MEDIA_TICKET_TTL_MS + 1)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of [undefined, null, '', 'nodot', '.', 'a.', '.b', 'x'.repeat(5000)]) {
      expect(verifyMediaTicket(SECRET, bad as string, NOW)).toBeNull();
    }
  });

  it('honours a caller-supplied TTL', () => {
    const { token } = signMediaTicket(SECRET, { p: '/a.jpg' }, NOW, 1000);
    expect(verifyMediaTicket(SECRET, token, NOW + 500)).not.toBeNull();
    expect(verifyMediaTicket(SECRET, token, NOW + 1500)).toBeNull();
  });
});
