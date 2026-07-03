import { findInsecureSecrets } from './configuration';

const strongA = 'A'.repeat(40);
const strongB = 'B'.repeat(40);

describe('findInsecureSecrets', () => {
  it('passes strong, distinct secrets', () => {
    expect(
      findInsecureSecrets({ accessSecret: strongA, encryptionKey: strongB }),
    ).toEqual([]);
  });

  it('flags the known dev defaults', () => {
    const problems = findInsecureSecrets({
      accessSecret: 'dev-access-secret-change-me',
      encryptionKey: 'dev-encryption-key-change-me',
    });
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join(' ')).toMatch(/JWT_ACCESS_SECRET/);
    expect(problems.join(' ')).toMatch(/ENCRYPTION_KEY/);
  });

  it('flags unset secrets', () => {
    expect(findInsecureSecrets({ accessSecret: '', encryptionKey: '' }).length).toBe(2);
  });

  it('flags too-short secrets', () => {
    const problems = findInsecureSecrets({ accessSecret: 'short', encryptionKey: strongB });
    expect(problems.join(' ')).toMatch(/too short/);
  });

  it('requires the encryption key to differ from the access secret', () => {
    const problems = findInsecureSecrets({ accessSecret: strongA, encryptionKey: strongA });
    expect(problems.join(' ')).toMatch(/must be different/);
  });
});
