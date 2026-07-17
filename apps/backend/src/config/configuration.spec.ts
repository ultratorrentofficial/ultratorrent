import { findInsecureSecrets } from './configuration';

const strongA = 'A'.repeat(40);
const strongB = 'B'.repeat(40);
const strongC = 'C'.repeat(40);

describe('findInsecureSecrets', () => {
  it('passes strong, distinct secrets', () => {
    expect(
      findInsecureSecrets({ accessSecret: strongA, refreshSecret: strongC, encryptionKey: strongB }),
    ).toEqual([]);
  });

  it('flags the known dev defaults (incl. the refresh secret)', () => {
    const problems = findInsecureSecrets({
      accessSecret: 'dev-access-secret-change-me',
      refreshSecret: 'dev-refresh-secret-change-me',
      encryptionKey: 'dev-encryption-key-change-me',
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join(' ')).toMatch(/JWT_ACCESS_SECRET/);
    expect(problems.join(' ')).toMatch(/JWT_REFRESH_SECRET/);
    expect(problems.join(' ')).toMatch(/ENCRYPTION_KEY/);
  });

  it('flags unset secrets (all three)', () => {
    expect(
      findInsecureSecrets({ accessSecret: '', refreshSecret: '', encryptionKey: '' }).length,
    ).toBe(3);
  });

  it('flags too-short secrets', () => {
    const problems = findInsecureSecrets({ accessSecret: 'short', refreshSecret: strongC, encryptionKey: strongB });
    expect(problems.join(' ')).toMatch(/too short/);
  });

  it('requires the encryption key to differ from the access secret', () => {
    const problems = findInsecureSecrets({ accessSecret: strongA, refreshSecret: strongC, encryptionKey: strongA });
    expect(problems.join(' ')).toMatch(/ENCRYPTION_KEY must be different/);
  });

  it('requires the refresh secret to differ from the access secret', () => {
    const problems = findInsecureSecrets({ accessSecret: strongA, refreshSecret: strongA, encryptionKey: strongB });
    expect(problems.join(' ')).toMatch(/JWT_REFRESH_SECRET must be different/);
  });
});
