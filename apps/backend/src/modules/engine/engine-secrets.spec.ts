import { ConfigService } from '@nestjs/config';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import {
  decryptEngineConfig,
  encryptEngineConfig,
  hasEngineSecret,
} from './engine-secrets';

const cipher = new SecretCipher({
  get: () => 'unit-test-encryption-key-at-least-32-chars-long',
} as unknown as ConfigService);

describe('engine-secrets', () => {
  it('encrypts the password, marks it, and leaves non-secret fields plaintext', () => {
    const stored = encryptEngineConfig(cipher, {
      baseUrl: 'http://qbittorrent:8080',
      username: 'admin',
      password: 's3cret',
    });
    expect(stored.baseUrl).toBe('http://qbittorrent:8080');
    expect(stored.username).toBe('admin');
    expect(stored.password).not.toBe('s3cret'); // ciphertext
    expect(stored.__encrypted).toEqual(['password']);
    expect(hasEngineSecret(stored, 'password')).toBe(true);
  });

  it('round-trips through decrypt', () => {
    const stored = encryptEngineConfig(cipher, {
      baseUrl: 'http://q:8080',
      password: 'p@ss',
    });
    const clear = decryptEngineConfig(cipher, stored);
    expect(clear.password).toBe('p@ss');
    expect(clear.baseUrl).toBe('http://q:8080');
    expect(clear.__encrypted).toBeUndefined();
  });

  it('records no secret marker when there is no password (rtorrent config)', () => {
    const stored = encryptEngineConfig(cipher, {
      mode: 'scgi-tcp',
      host: 'rtorrent',
      port: 5000,
    });
    expect(stored.__encrypted).toBeUndefined();
    expect(hasEngineSecret(stored, 'password')).toBe(false);
  });

  it('fails a secret field closed when the key cannot decrypt it', () => {
    const clear = decryptEngineConfig(cipher, {
      password: 'not-valid-ciphertext',
      __encrypted: ['password'],
    });
    expect(clear.password).toBeUndefined();
  });
});
