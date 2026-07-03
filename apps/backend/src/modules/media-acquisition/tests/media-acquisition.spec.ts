import { AcquisitionEvaluatorService } from '../evaluator.service';
import { AcquisitionWatchlistService } from '../watchlist.service';
import { AcquisitionProfileService } from '../profile.service';
import { AcquisitionApprovalService } from '../approval.service';
import { makeFakePrisma } from './fake-prisma';

const audit = () => ({ record: jest.fn().mockResolvedValue(undefined) });
const realtime = () => ({ broadcast: jest.fn() });
const MODELS = [
  'mediaAcquisitionWatchlistItem', 'mediaAcquisitionProfile', 'mediaAcquisitionEvaluation',
  'mediaAcquisitionAction', 'mediaAcquisitionHistory', 'torrentSnapshot', 'setting',
];

function build() {
  const prisma = makeFakePrisma(MODELS);
  const rt = realtime();
  const evaluator = new AcquisitionEvaluatorService(prisma as any, audit() as any, rt as any);
  const watchlist = new AcquisitionWatchlistService(prisma as any, audit() as any, rt as any);
  const profiles = new AcquisitionProfileService(prisma as any, audit() as any);
  const approval = new AcquisitionApprovalService(prisma as any, audit() as any, rt as any);
  return { prisma, rt, evaluator, watchlist, profiles, approval };
}

const RELEASE = 'The Show S01E02 1080p WEB-DL x265-GRP';

describe('Watchlist + Profile CRUD', () => {
  it('creates/updates/deletes a watchlist item with normalized title', async () => {
    const { watchlist, prisma } = build();
    const item = await watchlist.create({ type: 'series', title: 'The Show', priority: 5 }, 'u1');
    expect(item.normalizedTitle).toBe('the show');
    await watchlist.update(item.id, { status: 'paused' }, 'u1');
    expect((await watchlist.get(item.id)).status).toBe('paused');
    await watchlist.remove(item.id, 'u1');
    expect(prisma.mediaAcquisitionWatchlistItem.rows).toHaveLength(0);
  });

  it('creates a profile with quality preferences', async () => {
    const { profiles } = build();
    const p = await profiles.create({ name: 'TV 1080p HEVC', mediaType: 'tv', minimumScore: 85, approvalScore: 90, excludedTerms: ['CAM'] }, 'u1');
    expect(p.minimumScore).toBe(85);
    expect(p.enabled).toBe(true);
  });
});

describe('Acquisition evaluation', () => {
  it('recommends download for a missing, watchlisted release above thresholds', async () => {
    const { evaluator, watchlist, profiles, prisma, rt } = build();
    await watchlist.create({ type: 'series', title: 'The Show' });
    await profiles.create({ name: 'P', mediaType: 'tv', minimumScore: 50, approvalScore: 0, preferredResolution: '1080p', preferredCodec: 'x265', preferredSource: 'web' });

    const ev = await evaluator.evaluate({ releaseName: RELEASE, sourceType: 'manual' }, 'u1');
    expect(ev.decision).toBe('download');
    expect(ev.requiresApproval).toBe(false);
    expect((ev.trace as any).steps.length).toBeGreaterThan(2); // explainable
    // a pending download recommendation is recorded (NOT executed)
    expect(prisma.mediaAcquisitionAction.rows.find((a: any) => a.actionType === 'download_torrent')?.status).toBe('pending');
    expect(rt.broadcast).toHaveBeenCalledWith('media_acquisition.download.recommended', expect.any(Object));
  });

  it('skips when the episode is already owned in equal quality', async () => {
    const { evaluator, watchlist, profiles, prisma } = build();
    await watchlist.create({ type: 'series', title: 'The Show' });
    await profiles.create({ name: 'P', mediaType: 'tv', minimumScore: 50, approvalScore: 0 });
    await prisma.torrentSnapshot.create({ data: { name: 'The Show S01E02 1080p WEB-DL x264-OLD', state: 'seeding' } });

    const ev = await evaluator.evaluate({ releaseName: RELEASE }, 'u1');
    expect(ev.decision).toBe('skip');
    expect(ev.decisionReason).toMatch(/Already owned/);
  });

  it('holds for approval when below the approval score', async () => {
    const { evaluator, watchlist, profiles } = build();
    await watchlist.create({ type: 'series', title: 'The Show' });
    await profiles.create({ name: 'P', mediaType: 'tv', minimumScore: 50, approvalScore: 99 });

    const ev = await evaluator.evaluate({ releaseName: RELEASE }, 'u1');
    expect(ev.decision).toBe('hold_for_approval');
    expect(ev.approvalStatus).toBe('pending');
  });
});

describe('Approval queue', () => {
  async function heldEvaluation() {
    const ctx = build();
    await ctx.watchlist.create({ type: 'series', title: 'The Show' });
    await ctx.profiles.create({ name: 'P', mediaType: 'tv', minimumScore: 50, approvalScore: 99 });
    const ev = await ctx.evaluator.evaluate({ releaseName: RELEASE }, 'u1');
    return { ctx, ev };
  }

  it('approve → approved + pending download action', async () => {
    const { ctx, ev } = await heldEvaluation();
    const r = await ctx.approval.approve(ev.id, 'u1');
    expect(r.approvalStatus).toBe('approved');
    expect(ctx.prisma.mediaAcquisitionAction.rows.some((a: any) => a.actionType === 'download_torrent')).toBe(true);
    await expect(ctx.approval.approve(ev.id, 'u1')).rejects.toThrow(/not pending/);
  });

  it('reject → rejected, no download action', async () => {
    const { ctx, ev } = await heldEvaluation();
    const r = await ctx.approval.reject(ev.id, 'too risky', 'u1');
    expect(r.approvalStatus).toBe('rejected');
    expect(ctx.prisma.mediaAcquisitionAction.rows).toHaveLength(0);
  });

  it('override to skip → rejected; override to download → approved + action', async () => {
    const a = await heldEvaluation();
    const r1 = await a.ctx.approval.override(a.ev.id, 'skip', 'not wanted', 'u1');
    expect(r1.approvalStatus).toBe('rejected');

    const b = await heldEvaluation();
    const r2 = await b.ctx.approval.override(b.ev.id, 'download', 'I want it', 'u1');
    expect(r2.approvalStatus).toBe('approved');
    expect(b.ctx.prisma.mediaAcquisitionAction.rows.some((a: any) => a.payload?.override)).toBe(true);
  });
});
