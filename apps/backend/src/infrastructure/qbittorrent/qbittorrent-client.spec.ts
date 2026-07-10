import { QbittorrentClient } from './qbittorrent-client';

/** Build a minimal Response-like object for the fetch mock. */
function res(
  status: number,
  body = '',
  setCookie?: string,
): Partial<Response> {
  return {
    status,
    text: async () => body,
    headers: {
      getSetCookie: () => (setCookie ? [setCookie] : []),
      get: (h: string) => (h === 'set-cookie' ? (setCookie ?? null) : null),
    } as unknown as Headers,
  };
}

describe('QbittorrentClient auth', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  const client = () =>
    new QbittorrentClient({
      baseUrl: 'http://qbittorrent:8080/',
      username: 'admin',
      password: 'pw',
    });

  it('logs in on 204 + QBT_SID_<port> cookie and sends it back verbatim', async () => {
    fetchMock
      .mockResolvedValueOnce(res(204, '', 'QBT_SID_8080=abc123; HttpOnly; path=/'))
      .mockResolvedValueOnce(res(200, '5.0.4'));

    const version = await client().getText('/app/version');
    expect(version).toBe('5.0.4');

    // First call is the login POST; second carries the session cookie.
    const [loginUrl, loginInit] = fetchMock.mock.calls[0];
    expect(loginUrl).toBe('http://qbittorrent:8080/api/v2/auth/login');
    expect(loginInit.method).toBe('POST');
    const [, getInit] = fetchMock.mock.calls[1];
    expect(getInit.headers.Cookie).toBe('QBT_SID_8080=abc123');
    expect(getInit.headers.Referer).toBe('http://qbittorrent:8080');
  });

  it('logs in on the older 200 "Ok." + SID cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, 'Ok.', 'SID=legacy; path=/'))
      .mockResolvedValueOnce(res(200, '4.6.5'));
    await expect(client().getText('/app/version')).resolves.toBe('4.6.5');
    expect(fetchMock.mock.calls[1][1].headers.Cookie).toBe('SID=legacy');
  });

  it('throws on bad credentials (200 "Fails.")', async () => {
    fetchMock.mockResolvedValueOnce(res(200, 'Fails.'));
    await expect(client().getText('/app/version')).rejects.toThrow(
      /login failed/i,
    );
  });

  it('re-authenticates once on a 403 then retries the request', async () => {
    fetchMock
      .mockResolvedValueOnce(res(204, '', 'QBT_SID_8080=one; path=/')) // login
      .mockResolvedValueOnce(res(403)) // request → session expired
      .mockResolvedValueOnce(res(204, '', 'QBT_SID_8080=two; path=/')) // re-login
      .mockResolvedValueOnce(res(200, '[]')); // retry succeeds

    const out = await client().getJson('/torrents/info');
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers.Cookie).toBe('QBT_SID_8080=two');
  });
});
