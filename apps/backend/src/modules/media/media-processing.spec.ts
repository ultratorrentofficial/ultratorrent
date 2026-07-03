import { BadRequestException } from '@nestjs/common';
import { MediaAutomationActions } from './media-automation.actions';
import { MediaProcessingService, isWithin } from './media-processing.service';

/** A queue stub whose `run` just invokes the body with a no-op reporter. */
function queueStub() {
  return {
    run: jest.fn(async (_type: string, _opts: unknown, fn: (r: any) => any) =>
      fn(async () => undefined),
    ),
    create: jest.fn(),
    start: jest.fn(),
    progress: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  } as any;
}

describe('isWithin', () => {
  it('treats equal and descendant paths as within', () => {
    expect(isWithin('/media/tv', '/media/tv')).toBe(true);
    expect(isWithin('/media/tv/Show/ep.mkv', '/media/tv')).toBe(true);
  });
  it('rejects siblings and partial-name matches', () => {
    expect(isWithin('/media/tv2/x', '/media/tv')).toBe(false);
    expect(isWithin('/other', '/media/tv')).toBe(false);
  });
});

describe('MediaAutomationActions.execute', () => {
  function make() {
    const scanner = { scanLibrary: jest.fn().mockResolvedValue({ scanned: 3 }) };
    const identification = { identify: jest.fn().mockResolvedValue({ matchStatus: 'matched' }) };
    const metadata = { fetchMetadata: jest.fn().mockResolvedValue({}) };
    const artwork = { detectMissing: jest.fn().mockResolvedValue({ missing: [] }) };
    const nfo = { generate: jest.fn().mockResolvedValue({ generated: 1 }) };
    const integrations = { refresh: jest.fn().mockResolvedValue({ id: 'i' }) };
    const media = { apply: jest.fn().mockResolvedValue({ applied: 1 }) };
    const prisma = { mediaItem: { findMany: jest.fn(), findUnique: jest.fn() } } as any;
    const queue = queueStub();
    const actions = new MediaAutomationActions(
      prisma,
      scanner as any,
      identification as any,
      metadata as any,
      artwork as any,
      nfo as any,
      integrations as any,
      media as any,
      queue,
    );
    return { actions, scanner, identification, metadata, artwork, nfo, integrations, media, queue };
  }

  it('dispatches media_scan_library to the scanner through a job', async () => {
    const { actions, scanner, queue } = make();
    await actions.execute('media_scan_library', { libraryId: 'L1' });
    expect(scanner.scanLibrary).toHaveBeenCalledWith('L1');
    expect(queue.run).toHaveBeenCalledWith('library_scan', { libraryId: 'L1' }, expect.any(Function));
  });

  it('dispatches media_match to identification', async () => {
    const { actions, identification } = make();
    await actions.execute('media_match', { itemId: 'I1' });
    expect(identification.identify).toHaveBeenCalledWith('I1');
  });

  it('dispatches media_server_refresh to the integration', async () => {
    const { actions, integrations } = make();
    await actions.execute('media_server_refresh', { integrationId: 'X1' });
    expect(integrations.refresh).toHaveBeenCalledWith('X1', {});
  });

  it('requires libraryId for a scan', async () => {
    const { actions } = make();
    await expect(actions.execute('media_scan_library', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unknown action', async () => {
    const { actions } = make();
    await expect(actions.execute('media_bogus', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('MediaProcessingService.handleTorrentCompleted', () => {
  function torrent(savePath: string | null) {
    return { hash: 'H', name: 'Show.S01E01', savePath, engineId: 'e1' } as any;
  }

  function make(libraries: Array<{ id: string; path: string; isEnabled?: boolean }>) {
    const prisma = {
      mediaLibrary: { findMany: jest.fn().mockResolvedValue(libraries) },
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
      mediaServerIntegration: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const automation = { evaluate: jest.fn().mockResolvedValue(undefined) };
    const scanner = { scanLibrary: jest.fn().mockResolvedValue({ scanned: 0 }) };
    const identification = { identify: jest.fn() };
    const subtitles = { scan: jest.fn(), detectMissing: jest.fn() };
    const integrations = {};
    const actions = { execute: jest.fn().mockResolvedValue(undefined) };
    const queue = queueStub();
    const svc = new MediaProcessingService(
      prisma,
      automation as any,
      scanner as any,
      identification as any,
      subtitles as any,
      integrations as any,
      actions as any,
      queue,
    );
    return { svc, scanner, automation, prisma };
  }

  it('does nothing when no library covers the savePath (opt-in)', async () => {
    const { svc, scanner } = make([{ id: 'L', path: '/media/movies' }]);
    await svc.handleTorrentCompleted(torrent('/downloads/random'));
    expect(scanner.scanLibrary).not.toHaveBeenCalled();
  });

  it('scans and fires media.detected when a library covers the download', async () => {
    const { svc, scanner, automation } = make([{ id: 'L', path: '/media/tv' }]);
    await svc.handleTorrentCompleted(torrent('/media/tv/Show'));
    expect(scanner.scanLibrary).toHaveBeenCalledWith('L');
    expect(automation.evaluate).toHaveBeenCalledWith('media.detected', expect.anything());
  });

  it('ignores torrents without a savePath', async () => {
    const { svc, scanner } = make([{ id: 'L', path: '/media/tv' }]);
    await svc.handleTorrentCompleted(torrent(null));
    expect(scanner.scanLibrary).not.toHaveBeenCalled();
  });
});
