/**
 * Why the scheduled import was not running.
 *
 * Reported as "the import process should be launched automatically according to
 * the specified amount of hours … that process is not running on schedule".
 * The code was correct; the configuration made it inert. Read from the live
 * install: `autoDownloadEnabled: true`, `autoUpdateIntervalHours: 168`, and
 * `mode: 'disabled'` — and the very first gate is a dataset mode, so the tick
 * returned immediately every hour with nothing said anywhere.
 *
 * These pin the gate AND the diagnosis, because a silent early return is what
 * made a configuration problem look like a broken feature.
 */
import { ImdbDatasetScheduler } from './imdb-dataset-scheduler.service';

const settingsOf = (over: Record<string, unknown> = {}) => ({
  mode: 'dataset', autoDownloadEnabled: true, autoUpdateIntervalHours: 24, ...over,
});

function build(over: Record<string, unknown> = {}) {
  const imdb = {
    latestImportAt: jest.fn(async () => null),
    runDatasetUpdate: jest.fn(async () => undefined),
  };
  const settings = { read: jest.fn(async () => settingsOf(over)) };
  const svc = new ImdbDatasetScheduler(imdb as never, settings as never);
  const warn = jest.spyOn((svc as never as { logger: { warn: (m: string) => void } }).logger, 'warn')
    .mockImplementation(() => undefined);
  jest.spyOn((svc as never as { logger: { log: (m: string) => void } }).logger, 'log')
    .mockImplementation(() => undefined);
  return { svc, imdb, warn };
}

describe('IMDb auto-update gating', () => {
  it('runs when the mode uses datasets and auto-download is on', async () => {
    const { svc, imdb } = build();
    await svc.tick();
    expect(imdb.runDatasetUpdate).toHaveBeenCalled();
  });

  it('runs in hybrid mode too', async () => {
    const { svc, imdb } = build({ mode: 'hybrid' });
    await svc.tick();
    expect(imdb.runDatasetUpdate).toHaveBeenCalled();
  });

  it('does NOT run when the mode is disabled, even with auto-download on', async () => {
    // The live configuration. Importing for a disabled provider would be work
    // nobody asked for, so the gate is right — the silence was the defect.
    const { svc, imdb } = build({ mode: 'disabled' });
    await svc.tick();
    expect(imdb.runDatasetUpdate).not.toHaveBeenCalled();
  });

  it('explains itself when auto-update is on but the mode makes it inert', async () => {
    const { svc, warn } = build({ mode: 'disabled', autoUpdateIntervalHours: 168 });
    await svc.tick();
    const msg = warn.mock.calls[0]?.[0] as string;
    // The message has to name both the interval the operator set and the mode
    // that is overriding it, or it does not answer the question they will ask.
    expect(msg).toContain('168');
    expect(msg).toContain('disabled');
  });

  it('warns once, not on every hourly tick', async () => {
    const { svc, warn } = build({ mode: 'disabled' });
    await svc.tick();
    await svc.tick();
    await svc.tick();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent when auto-download is simply off', async () => {
    // Nothing is being promised, so there is nothing to explain.
    const { svc, warn, imdb } = build({ mode: 'disabled', autoDownloadEnabled: false });
    await svc.tick();
    expect(warn).not.toHaveBeenCalled();
    expect(imdb.runDatasetUpdate).not.toHaveBeenCalled();
  });

  it('skips a run that is not due yet', async () => {
    const { svc, imdb } = build({ autoUpdateIntervalHours: 24 });
    imdb.latestImportAt.mockResolvedValue(new Date() as never);
    await svc.tick();
    expect(imdb.runDatasetUpdate).not.toHaveBeenCalled();
  });
});
