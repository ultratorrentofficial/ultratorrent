import { SmartDownloadExecutorService } from '../smart-download-executor.service';
import { makeFakePrisma } from './fake-prisma';

const audit = () => ({ record: jest.fn().mockResolvedValue(undefined) });
const realtime = () => ({ broadcast: jest.fn() });

function makeProvider(over: Record<string, unknown> = {}) {
  return {
    addMagnet: jest.fn().mockResolvedValue('new-hash'),
    addTorrentURL: jest.fn().mockResolvedValue('new-hash'),
    removeTorrentAndData: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function build(prov = makeProvider()) {
  const prisma = makeFakePrisma([
    'mediaAcquisitionAction',
    'mediaAcquisitionEvaluation',
    'mediaAcquisitionHistory',
  ]);
  const rt = realtime();
  const registry = { getDefault: jest.fn().mockResolvedValue(prov) };
  const svc = new SmartDownloadExecutorService(prisma as any, registry as any, audit() as any, rt as any);
  return { prisma, rt, prov, svc };
}

async function seed(
  prisma: any,
  decision: string,
  payload: Record<string, unknown>,
) {
  const ev = await prisma.mediaAcquisitionEvaluation.create({
    data: { decision, releaseName: 'The Show S01E02 1080p BluRay x265-GRP', approvalStatus: 'not_required' },
  });
  const action = await prisma.mediaAcquisitionAction.create({
    data: { evaluationId: ev.id, actionType: 'download_torrent', status: 'pending', payload },
  });
  return { ev, action };
}

describe('SmartDownloadExecutorService', () => {
  it('adds a magnet and completes the action', async () => {
    const { prisma, rt, prov, svc } = build();
    const { action, ev } = await seed(prisma, 'download', { downloadUrl: 'magnet:?xt=urn:btih:abc' });

    const res = await svc.executeAction(action.id, 'u1');

    expect(res).toMatchObject({ status: 'completed', torrentHash: 'new-hash', removedHash: null });
    expect(prov.addMagnet).toHaveBeenCalledTimes(1);
    expect(prov.removeTorrentAndData).not.toHaveBeenCalled();
    const stored = await prisma.mediaAcquisitionAction.findUnique({ where: { id: action.id } });
    expect(stored.status).toBe('completed');
    expect(stored.result.torrentHash).toBe('new-hash');
    const evAfter = await prisma.mediaAcquisitionEvaluation.findUnique({ where: { id: ev.id } });
    expect(evAfter.actionTaken).toBe('downloaded');
    expect(rt.broadcast).toHaveBeenCalledWith('media_acquisition.download.started', expect.any(Object));
  });

  it('uses addTorrentURL for a non-magnet link', async () => {
    const { prisma, prov, svc } = build();
    const { action } = await seed(prisma, 'download', { downloadUrl: 'https://x/y.torrent' });
    await svc.executeAction(action.id);
    expect(prov.addTorrentURL).toHaveBeenCalledTimes(1);
    expect(prov.addMagnet).not.toHaveBeenCalled();
  });

  it('on an upgrade, adds the new release and removes the superseded torrent', async () => {
    const { prisma, rt, prov, svc } = build();
    const { action } = await seed(prisma, 'upgrade_existing', {
      downloadUrl: 'magnet:?xt=urn:btih:new',
      supersedeHash: 'old-hash',
    });

    const res = await svc.executeAction(action.id, 'u1');

    expect(res).toMatchObject({ status: 'completed', torrentHash: 'new-hash', removedHash: 'old-hash' });
    expect(prov.removeTorrentAndData).toHaveBeenCalledWith('old-hash');
    expect(rt.broadcast).toHaveBeenCalledWith('media_acquisition.upgrade.completed', expect.any(Object));
  });

  it('is idempotent — a completed action is not re-executed', async () => {
    const { prisma, prov, svc } = build();
    const { action } = await seed(prisma, 'download', { downloadUrl: 'magnet:?xt=urn:btih:abc' });
    await svc.executeAction(action.id);
    const second = await svc.executeAction(action.id);
    expect(second.status).toBe('skipped');
    expect(prov.addMagnet).toHaveBeenCalledTimes(1);
  });

  it('marks the action failed when there is no download URL (advisory only)', async () => {
    const { prisma, prov, svc } = build();
    const { action } = await seed(prisma, 'download', { releaseName: 'X' });
    const res = await svc.executeAction(action.id);
    expect(res.status).toBe('failed');
    expect(prov.addMagnet).not.toHaveBeenCalled();
    const stored = await prisma.mediaAcquisitionAction.findUnique({ where: { id: action.id } });
    expect(stored.status).toBe('failed');
    expect(stored.errorMessage).toMatch(/no download URL/i);
  });

  it('records a failure and emits when the engine rejects', async () => {
    const prov = makeProvider({ addMagnet: jest.fn().mockRejectedValue(new Error('engine offline')) });
    const { prisma, rt, svc } = build(prov);
    const { action } = await seed(prisma, 'download', { downloadUrl: 'magnet:?xt=urn:btih:abc' });

    const res = await svc.executeAction(action.id);

    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/engine offline/);
    const stored = await prisma.mediaAcquisitionAction.findUnique({ where: { id: action.id } });
    expect(stored.status).toBe('failed');
    expect(rt.broadcast).toHaveBeenCalledWith('media_acquisition.download.failed', expect.any(Object));
  });

  it('executeForEvaluation finds and runs the pending action', async () => {
    const { prisma, prov, svc } = build();
    const { ev } = await seed(prisma, 'download', { downloadUrl: 'magnet:?xt=urn:btih:abc' });
    const res = await svc.executeForEvaluation(ev.id, 'u1');
    expect(res.status).toBe('completed');
    expect(prov.addMagnet).toHaveBeenCalledTimes(1);
  });
});
