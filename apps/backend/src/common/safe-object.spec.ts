import { infoHashFromTorrent } from '../infrastructure/rtorrent/bencode';
import { encryptEngineConfig } from '../modules/engine/engine-secrets';
import { isUnsafeObjectKey, safeEntries } from './safe-object';

/**
 * Prototype poisoning through a key name.
 *
 * The shape is always the same: a map whose KEYS come from outside is copied
 * into a fresh object. `JSON.parse` hands `__proto__` back as a real own
 * property, so it survives into `Object.entries`, and assigning it to an object
 * literal does not store an entry — it invokes the inherited setter and replaces
 * that object's prototype.
 */
describe('safeEntries refuses the keys that poison a copy', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('drops %s', (key) => {
    const input = JSON.parse(`{"apiKey":"real","${key}":{"polluted":true}}`);
    const keys = safeEntries(input).map(([k]) => k);
    expect(keys).toEqual(['apiKey']);
  });

  it('keeps every ordinary setting', () => {
    const input = { baseUrl: 'http://plex:32400', apiKey: 'k', port: 8080, enabled: true };
    expect(safeEntries(input).map(([k]) => k).sort()).toEqual(
      ['apiKey', 'baseUrl', 'enabled', 'port'],
    );
  });

  it('copies without hijacking the target prototype', () => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of safeEntries(JSON.parse('{"__proto__":{"x":1},"ok":2}'))) out[k] = v;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { x?: unknown }).x).toBeUndefined();
    expect(out.ok).toBe(2);
  });

  it('is not fooled by a non-object or an array', () => {
    expect(safeEntries(null)).toEqual([]);
    expect(safeEntries('string')).toEqual([]);
    expect(safeEntries([1, 2])).toEqual([]);
  });

  it('names the keys it refuses', () => {
    expect(isUnsafeObjectKey('__proto__')).toBe(true);
    expect(isUnsafeObjectKey('apiKey')).toBe(false);
  });
});

describe('engine config copying survives a hostile key', () => {
  const cipher = { encrypt: (v: string) => `enc:${v}` } as never;

  it('does not let a config key replace the result prototype', () => {
    const hostile = JSON.parse('{"password":"p","__proto__":{"isAdmin":true}}');
    const out = encryptEngineConfig(cipher, hostile);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  });

  it('still encrypts the real secret beside it', () => {
    const out = encryptEngineConfig(cipher, JSON.parse('{"password":"p","__proto__":{"x":1}}'));
    expect(out.password).toBe('enc:p');
  });
});

/**
 * A `.torrent` file is downloaded from a tracker and is entirely untrusted, and
 * bencode lets a dict name any key — including `__proto__`. That map is internal
 * and only ever read by key, so it gets no prototype at all.
 *
 * Exercised through the public `infoHashFromTorrent`, which is the only thing
 * that reads the parsed dict, rather than by exporting the reader for a test.
 */
describe('the bencode parser cannot be steered by a hostile dict key', () => {
  /** A minimal, ordinary torrent: `d4:infod6:lengthi1234eee`. */
  const ordinary = Buffer.from('d4:infod6:lengthi1234eee');

  it('still computes the info hash of an ordinary torrent', () => {
    expect(infoHashFromTorrent(ordinary)).toMatch(/^[0-9a-f]{40}$/);
  });

  /*
   * A `__proto__` key alongside a real `info`. On a prototype-bearing object the
   * assignment would have replaced the dict's prototype instead of storing the
   * entry; the hash must be unaffected either way.
   */
  it('ignores a __proto__ key sitting beside a real info dictionary', () => {
    const hostile = Buffer.from('d9:__proto__d6:lengthi1ee4:infod6:lengthi1234eee');
    expect(infoHashFromTorrent(hostile)).toBe(infoHashFromTorrent(ordinary));
  });

  /*
   * The property that matters. A torrent declaring no `info` must be refused —
   * never satisfied by a lookup that resolved through an attacker-supplied
   * prototype.
   */
  it('refuses a torrent that declares no info dictionary', () => {
    const noInfo = Buffer.from('d9:__proto__d6:lengthi1eee');
    expect(() => infoHashFromTorrent(noInfo)).toThrow(/missing info/i);
  });

  it('refuses one whose only keys are inherited names', () => {
    for (const key of ['constructor', 'toString', 'valueOf']) {
      const buf = Buffer.from(`d${key.length}:${key}i1ee`);
      expect(() => infoHashFromTorrent(buf)).toThrow(/missing info/i);
    }
  });
});
