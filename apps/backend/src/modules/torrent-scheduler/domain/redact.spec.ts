import { redactForEvent } from './redact';

/**
 * Credentials must not ride out on an event.
 *
 * A provider error is written by a library that has no idea the string will
 * travel, and a scheduler event reaches automation and from there a webhook to
 * somebody else's server. An operator cannot un-send that.
 */
describe('redactForEvent', () => {
  it('removes a passkey from a tracker URL', () => {
    const out = redactForEvent('announce failed: https://tracker.example/announce?passkey=abc123secret');
    expect(out).not.toContain('abc123secret');
  });

  it('removes credentials embedded in a URL', () => {
    const out = redactForEvent('connect failed http://admin:hunter2@10.0.0.5:8080/api');
    expect(out).not.toContain('hunter2');
  });

  it('removes a bare API token parameter', () => {
    expect(redactForEvent('rejected: token=9f8e7d6c5b4a')).not.toContain('9f8e7d6c5b4a');
  });

  it('removes a long hex run that could be a key', () => {
    const key = 'a'.repeat(40);
    expect(redactForEvent(`auth ${key} rejected`)).not.toContain(key);
  });

  it('keeps enough of the message to be useful', () => {
    // Aggressive redaction is only acceptable if what remains still says what
    // went wrong.
    expect(redactForEvent('403 Forbidden from engine')).toBe('403 Forbidden from engine');
  });

  it('truncates a message that would otherwise be unbounded', () => {
    const out = redactForEvent('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(301);
  });

  it('handles an absent message without throwing', () => {
    expect(redactForEvent(undefined)).toBe('');
    expect(redactForEvent(null)).toBe('');
  });
});
