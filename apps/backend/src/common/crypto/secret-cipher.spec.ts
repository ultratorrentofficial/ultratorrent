import { ConfigService } from '@nestjs/config';
import { SecretCipher } from './secret-cipher';

function cipherWith(key: string): SecretCipher {
  return new SecretCipher({
    get: () => key,
  } as unknown as ConfigService);
}

describe('SecretCipher', () => {
  it('round-trips a secret', () => {
    const cipher = cipherWith('test-key');
    const secret = 'JBSWY3DPEHPK3PXP';
    const enc = cipher.encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(cipher.decrypt(enc)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const cipher = cipherWith('test-key');
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('fails to decrypt with the wrong key', () => {
    const enc = cipherWith('key-a').encrypt('secret');
    expect(() => cipherWith('key-b').decrypt(enc)).toThrow();
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const cipher = cipherWith('test-key');
    const enc = cipher.encrypt('secret');
    const raw = Buffer.from(enc, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => cipher.decrypt(raw.toString('base64'))).toThrow();
  });
});
