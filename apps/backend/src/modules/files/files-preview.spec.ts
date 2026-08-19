import { BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import { FilesService } from './files.service';
import { FilePathService } from './file-path.service';

function configFor(root: string): any {
  return { get: (k: string) => (k === 'fileManager.roots' ? [root] : undefined) };
}

/** Minimal Express response double: records status and headers, ignores the body. */
function responseDouble() {
  const headers: Record<string, string> = {};
  let status = 200;
  const res = {
    set: (h: Record<string, string>) => { Object.assign(headers, h); return res; },
    status: (code: number) => { status = code; return res; },
    getHeader: (name: string) => headers[name],
    removeHeader: (name: string) => { delete headers[name]; },
  };
  return { res: res as unknown as Response, headers, get status() { return status; } };
}

describe('FilesService preview + streaming', () => {
  let root: string;
  let svc: FilesService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ut-preview-'));
    const paths = new FilePathService(configFor(root), { get: async () => undefined, set: async () => {} } as any);
    svc = new FilesService(
      paths as any,
      { record: jest.fn() } as any,
      { broadcast: jest.fn() } as any,
      { moveToTrash: jest.fn() } as any,
      { publish: jest.fn() } as any,
      { get: jest.fn() } as never,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('preview', () => {
    it('classifies an image as streamable and returns no bytes', async () => {
      await writeFile(join(root, 'poster.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      const res = await svc.preview('/poster.jpg');
      expect(res).toMatchObject({ kind: 'image', mime: 'image/jpeg', streamable: true, content: null });
    });

    it('classifies a video without trying to read it as text', async () => {
      await writeFile(join(root, 'film.mkv'), Buffer.alloc(64, 0));
      const res = await svc.preview('/film.mkv');
      expect(res).toMatchObject({ kind: 'video', mime: 'video/x-matroska', streamable: true });
    });

    it('decodes a CP437 NFO into readable box drawing', async () => {
      await writeFile(join(root, 'release.nfo'), Buffer.from([0xc9, ...Array(20).fill(0xcd), 0xbb]));
      const res = await svc.preview('/release.nfo');
      expect(res.kind).toBe('nfo');
      expect(res.detectedEncoding).toBe('cp437');
      expect(res.content).toContain('╔');
      expect(res.content).toContain('╗');
    });

    /* The viewer's encoding picker sends the choice back here — the browser
     * never receives the raw bytes, so it cannot re-decode them itself. */
    it('honours a caller-supplied encoding over detection', async () => {
      await writeFile(join(root, 'release.nfo'), Buffer.from([0xc9, ...Array(20).fill(0xcd), 0xbb]));
      const res = await svc.preview('/release.nfo', { encoding: 'latin1' });
      expect(res.encoding).toBe('latin1');
      expect(res.detectedEncoding).toBe('cp437');
      expect(res.content).not.toContain('╔');
    });

    /* The old ceiling refused anything over 256 KB outright. A long log is a
     * normal thing to find here, and its head is worth more than an error. */
    it('reads the head of an oversized text file and flags it', async () => {
      await writeFile(join(root, 'big.log'), 'x'.repeat(2048));
      const res = await svc.preview('/big.log', { maxBytes: 512 });
      expect(res.truncated).toBe(true);
      expect(res.content).toHaveLength(512);
      expect(res.size).toBe(2048);
    });

    it('reports a reason instead of throwing for an archive', async () => {
      await writeFile(join(root, 'pack.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const res = await svc.preview('/pack.zip');
      expect(res.kind).toBe('archive');
      expect(res.reason).toMatch(/cannot be previewed/i);
    });

    /* An unknown extension is not a promise of binary — the bytes decide. */
    it('reads an extensionless text file, and refuses a binary one', async () => {
      await writeFile(join(root, 'README'), 'plain words');
      await expect(svc.preview('/README')).resolves.toMatchObject({ content: 'plain words' });

      await writeFile(join(root, 'blob.dat'), Buffer.from([0x01, 0x00, 0x02, 0x03]));
      const binary = await svc.preview('/blob.dat');
      expect(binary.content).toBeNull();
      expect(binary.reason).toMatch(/binary/i);
    });

    it('still refuses a directory', async () => {
      await mkdir(join(root, 'sub'));
      await expect(svc.preview('/sub')).rejects.toThrow(BadRequestException);
    });

    it('refuses to escape the root', async () => {
      await expect(svc.preview('/../../etc/passwd')).rejects.toThrow();
    });
  });

  describe('streamMedia', () => {
    beforeEach(async () => {
      await writeFile(join(root, 'clip.mp4'), Buffer.alloc(1000, 7));
    });

    it('serves the whole file inline with range support advertised', async () => {
      const probe = responseDouble();
      const { res, headers } = probe;
      await svc.streamMedia('/clip.mp4', undefined, res);
      expect(probe.status).toBe(200);
      expect(headers['Content-Type']).toBe('video/mp4');
      expect(headers['Accept-Ranges']).toBe('bytes');
      expect(headers['Content-Length']).toBe('1000');
      expect(headers['Content-Disposition']).toMatch(/^inline;/);
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('answers a range request with 206 and the exact window', async () => {
      const probe = responseDouble();
      const { res, headers } = probe;
      await svc.streamMedia('/clip.mp4', 'bytes=100-199', res);
      expect(probe.status).toBe(206);
      expect(headers['Content-Range']).toBe('bytes 100-199/1000');
      expect(headers['Content-Length']).toBe('100');
    });

    it('answers an out-of-bounds range with 416', async () => {
      const probe = responseDouble();
      const { res, headers } = probe;
      await svc.streamMedia('/clip.mp4', 'bytes=5000-', res);
      expect(probe.status).toBe(416);
      expect(headers['Content-Range']).toBe('bytes */1000');
    });

    /* An extension the MIME map does not vouch for must never be served as a
     * type the browser will execute on the API's own origin. */
    it('falls back to octet-stream for an unrecognised type', async () => {
      await writeFile(join(root, 'thing.weird'), 'data');
      const { res, headers } = responseDouble();
      await svc.streamMedia('/thing.weird', undefined, res);
      expect(headers['Content-Type']).toBe('application/octet-stream');
    });

    it('locks SVG down with a CSP, since it is a document as well as an image', async () => {
      await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      const { res, headers } = responseDouble();
      await svc.streamMedia('/logo.svg', undefined, res);
      expect(headers['Content-Type']).toBe('image/svg+xml');
      expect(headers['Content-Security-Policy']).toContain('sandbox');
    });

    it('refuses a directory and refuses to escape the root', async () => {
      await mkdir(join(root, 'sub'));
      const { res } = responseDouble();
      await expect(svc.streamMedia('/sub', undefined, res)).rejects.toThrow(BadRequestException);
      await expect(svc.streamMedia('/../../etc/passwd', undefined, res)).rejects.toThrow();
    });
  });
});
