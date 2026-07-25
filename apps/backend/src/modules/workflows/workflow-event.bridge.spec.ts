import { EventEmitter2 } from '@nestjs/event-emitter';
import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { WorkflowEventBridge } from './workflow-event.bridge';

/**
 * A workflow parked on `waiting_for_event` used to be unwakeable: only the
 * timeout sweep could end that state. These cover the path that restores it.
 */
function build(opts: {
  waiting?: Array<{ id: string; workflowVersionId: string }>;
  waitNodeId?: string | null;
  eventType?: string;
} = {}) {
  const resumed: Array<[string, string]> = [];
  const prisma: any = {
    workflowExecution: {
      findMany: jest.fn(async () => opts.waiting ?? [{ id: 'ex1', workflowVersionId: 'v1' }]),
    },
    workflowNodeExecution: {
      findFirst: jest.fn(async () =>
        opts.waitNodeId === null ? null : { nodeId: opts.waitNodeId ?? 'wait-1' },
      ),
    },
    workflowVersion: {
      findUnique: jest.fn(async () => ({
        graph: {
          nodes: [
            {
              id: 'wait-1',
              type: 'control.wait',
              config: { eventType: opts.eventType ?? DOMAIN_EVENTS.TORRENT_COMPLETED },
            },
          ],
        },
      })),
    },
  };
  const executions: any = {
    resume: jest.fn(async (id: string, port: string) => {
      resumed.push([id, port]);
    }),
  };
  const bus = new DomainEventBus(new EventEmitter2({ wildcard: true, delimiter: '.' }));
  const bridge = new WorkflowEventBridge(prisma, bus, executions);
  bridge.onModuleInit();
  return { bridge, bus, prisma, executions, resumed };
}

const publishCompleted = (bus: DomainEventBus) =>
  bus.publish({
    eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
    resourceType: 'torrent',
    resourceId: 'h1',
    payload: { torrentName: 'x', hash: 'h1' },
  });

const flush = () => new Promise((r) => setImmediate(r));

describe('WorkflowEventBridge', () => {
  it('resumes an execution whose wait node names the published event', async () => {
    const { bus, resumed } = build();
    publishCompleted(bus);
    await flush();
    expect(resumed).toEqual([['ex1', 'completed']]);
  });

  it('leaves an execution waiting when the event does not match its node', async () => {
    const { bus, resumed } = build({ eventType: DOMAIN_EVENTS.WORKFLOW_APPROVAL_REQUESTED });
    publishCompleted(bus);
    await flush();
    expect(resumed).toEqual([]);
  });

  it('does nothing when no execution is waiting', async () => {
    const { bus, resumed, prisma } = build({ waiting: [] });
    publishCompleted(bus);
    await flush();
    expect(resumed).toEqual([]);
    // Cheap path: it must not go on to read graphs.
    expect(prisma.workflowVersion.findUnique).not.toHaveBeenCalled();
  });

  it('skips an execution with no waiting node rather than throwing', async () => {
    const { bus, resumed } = build({ waitNodeId: null });
    publishCompleted(bus);
    await flush();
    expect(resumed).toEqual([]);
  });

  it('one broken execution does not stop the others resuming', async () => {
    const { bus, resumed, prisma, executions } = build({
      waiting: [
        { id: 'bad', workflowVersionId: 'v1' },
        { id: 'good', workflowVersionId: 'v1' },
      ],
    });
    prisma.workflowNodeExecution.findFirst = jest.fn(async ({ where }: any) => {
      if (where.workflowExecutionId === 'bad') throw new Error('corrupt row');
      return { nodeId: 'wait-1' };
    });

    publishCompleted(bus);
    await flush();

    expect(executions.resume).toHaveBeenCalledTimes(1);
    expect(resumed).toEqual([['good', 'completed']]);
  });

  it('stops receiving after unsubscribe', async () => {
    const { bridge, bus, resumed } = build();
    bridge.onModuleDestroy();
    publishCompleted(bus);
    await flush();
    expect(resumed).toEqual([]);
  });
});
