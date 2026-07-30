/**
 * The pipeline engine.
 *
 * The properties that matter are about what it does when things are NOT normal:
 * it must stop at a missing stage rather than skip it, resume rather than
 * restart, and tell a failure apart from a quarantine.
 */
import { IntakePipelineService, type IntakeStage } from './intake-pipeline.service';

let statBehaviour: () => { isFile: () => boolean; isDirectory: () => boolean; size: number };
jest.mock('node:fs/promises', () => ({ stat: jest.fn(async () => statBehaviour()) }));

function build(job: Record<string, unknown>) {
  const transitions: Array<{ to: string; message?: string }> = [];
  const prisma = { mediaIntakeJob: { findUnique: jest.fn(async () => job) } };
  const intake = {
    transition: jest.fn(async (_id: string, to: string, opts: { message?: string } = {}) => {
      transitions.push({ to, message: opts.message });
      return { id: 'j1', state: to };
    }),
  };
  const svc = new IntakePipelineService(prisma as never, intake as never);
  jest.spyOn((svc as never as { logger: { warn: (m: string) => void } }).logger, 'warn')
    .mockImplementation(() => undefined);
  return { svc, transitions, intake };
}

const jobAt = (state: string) => ({
  id: 'j1', state, sourcePath: '/staging/x.mkv', profileId: 'p1',
  torrentHash: 'abc', engineId: 'e1',
});

const stage = (produces: string, run?: IntakeStage['run']): IntakeStage => ({
  produces: produces as never,
  label: `stage:${produces}`,
  run: run ?? (async () => ({ message: 'ok' })),
});

beforeEach(() => {
  statBehaviour = () => ({ isFile: () => true, isDirectory: () => false, size: 1024 });
});

describe('stage sequencing', () => {
  it('runs verification and stops where the pipeline ends', async () => {
    /*
     * The pipeline is incomplete by construction while it is being built.
     * Reporting where it stopped is more useful than failing, and far better
     * than skipping ahead.
     */
    const { svc, transitions } = build(jobAt('completed'));
    const out = await svc.advance('j1');
    expect(transitions.map((t) => t.to)).toEqual(['verified']);
    expect(out.stopped).toBe('identified');
  });

  it('NEVER skips a stage it does not have', async () => {
    // Skipping would import something that was never identified.
    const { svc, transitions } = build(jobAt('completed'));
    svc.register(stage('imported'));
    await svc.advance('j1');
    expect(transitions.map((t) => t.to)).not.toContain('imported');
  });

  it('resumes from the current state instead of restarting', async () => {
    /*
     * A restart would re-fetch metadata and artwork that already succeeded, and
     * hammer every provider involved for no reason.
     */
    const { svc, transitions } = build(jobAt('artwork_ready'));
    svc.register(stage('subtitle_ready'));
    await svc.advance('j1');
    expect(transitions.map((t) => t.to)).toEqual(['subtitle_ready']);
  });

  it('keeps the table in lifecycle order however stages were registered', async () => {
    // A stage contributed by another module must not land in the wrong place.
    const { svc } = build(jobAt('completed'));
    svc.register(stage('metadata_ready'));
    svc.register(stage('identified'));
    expect(svc.registered()).toEqual(['verified', 'identified', 'metadata_ready']);
  });

  it('runs consecutive stages in one pass', async () => {
    // Consecutive in the LIFECYCLE order: quality scoring follows identification
    // because it feeds the import decision, and enrichment comes after import.
    const { svc, transitions } = build(jobAt('completed'));
    svc.register(stage('identified'));
    svc.register(stage('quality_scored'));
    await svc.advance('j1');
    expect(transitions.map((t) => t.to)).toEqual(['verified', 'identified', 'quality_scored']);
  });
});

describe('failure and quarantine are different things', () => {
  it('sends a throwing stage to failed, naming the stage', async () => {
    const { svc, transitions } = build(jobAt('completed'));
    svc.register(stage('identified', async () => { throw new Error('provider timeout'); }));
    const out = await svc.advance('j1');
    expect(out.state).toBe('failed');
    const failed = transitions.find((t) => t.to === 'failed');
    expect(failed?.message).toMatch(/stage:identified: provider timeout/);
  });

  it('stops the run at the first failure', async () => {
    // Continuing past a failure would act on a state that was never reached.
    const { svc, transitions } = build(jobAt('completed'));
    svc.register(stage('identified', async () => { throw new Error('boom'); }));
    svc.register(stage('metadata_ready'));
    await svc.advance('j1');
    expect(transitions.map((t) => t.to)).not.toContain('metadata_ready');
  });

  it('quarantines when a stage asks, without marking it failed', async () => {
    /*
     * A failure is "this did not work, try again"; a quarantine is "a human
     * must look at this". Conflating them means either retrying something that
     * can never succeed, or parking something that just needed a second go.
     */
    const { svc, transitions } = build(jobAt('completed'));
    const out = await svc.advance('j1');
    void out;
    // Re-run with an unreadable source to trigger the real verify quarantine.
    statBehaviour = () => { throw new Error('ENOENT'); };
    const second = build(jobAt('completed'));
    const result = await second.svc.advance('j1');
    expect(result.state).toBe('quarantined');
    expect(second.transitions[0]).toMatchObject({ to: 'quarantined' });
    expect(second.transitions.some((t) => t.to === 'failed')).toBe(false);
  });
});

describe('verification', () => {
  it('quarantines an unreadable source rather than retrying forever', async () => {
    // Missing data does not get better by trying again.
    statBehaviour = () => { throw new Error('ENOENT: no such file'); };
    const { svc, transitions } = build(jobAt('completed'));
    await svc.advance('j1');
    expect(transitions[0].to).toBe('quarantined');
    expect(transitions[0].message).toMatch(/unreadable/);
  });

  it('quarantines a zero-byte file', async () => {
    statBehaviour = () => ({ isFile: () => true, isDirectory: () => false, size: 0 });
    const { svc, transitions } = build(jobAt('completed'));
    await svc.advance('j1');
    expect(transitions[0]).toMatchObject({ to: 'quarantined' });
    expect(transitions[0].message).toMatch(/zero bytes/);
  });

  it('accepts a directory without checking its size', async () => {
    // A multi-file torrent is a directory; its own size means nothing.
    statBehaviour = () => ({ isFile: () => false, isDirectory: () => true, size: 0 });
    const { svc, transitions } = build(jobAt('completed'));
    await svc.advance('j1');
    expect(transitions[0].to).toBe('verified');
  });
});
