import { JobAutomationBridge } from './automation.module';

describe('JobAutomationBridge', () => {
  function make() {
    const engine = { evaluateEvent: jest.fn().mockResolvedValue(undefined) };
    const bridge = new JobAutomationBridge(engine as never);
    return { engine, bridge };
  }

  it('forwards a job.* event to the automation engine', async () => {
    const { engine, bridge } = make();
    await bridge.onDomainEvent({ event: 'job.failed', payload: { jobId: 'j1', jobType: 'media.library_scan' } });
    expect(engine.evaluateEvent).toHaveBeenCalledWith('job.failed', { jobId: 'j1', jobType: 'media.library_scan' });
  });

  it('ignores non-job events', async () => {
    const { engine, bridge } = make();
    await bridge.onDomainEvent({ event: 'media.matched', payload: {} });
    await bridge.onDomainEvent({ event: '', payload: {} } as never);
    expect(engine.evaluateEvent).not.toHaveBeenCalled();
  });

  it('never throws if the engine errors', async () => {
    const { engine, bridge } = make();
    engine.evaluateEvent.mockRejectedValueOnce(new Error('boom'));
    await expect(bridge.onDomainEvent({ event: 'job.stalled', payload: {} })).resolves.toBeUndefined();
  });
});
