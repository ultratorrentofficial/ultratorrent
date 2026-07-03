import { BadRequestException } from '@nestjs/common';
import { isBlockedAddress, fetchRemoteTorrent } from './ssrf';

describe('isBlockedAddress', () => {
  it('blocks the cloud metadata address', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
  });

  it('blocks loopback / private / CGNAT ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it('blocks IPv6 loopback / ULA / link-local / mapped-private', () => {
    for (const ip of ['::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv6 and blocks garbage', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('fetchRemoteTorrent', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(fetchRemoteTorrent('file:///etc/passwd')).rejects.toBeInstanceOf(BadRequestException);
    await expect(fetchRemoteTorrent('ftp://example.com/x.torrent')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(fetchRemoteTorrent('gopher://x')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects URLs whose literal host is an internal address (no fetch)', async () => {
    await expect(fetchRemoteTorrent('http://127.0.0.1/t.torrent')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      fetchRemoteTorrent('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid URL', async () => {
    await expect(fetchRemoteTorrent('not a url')).rejects.toBeInstanceOf(BadRequestException);
  });
});
