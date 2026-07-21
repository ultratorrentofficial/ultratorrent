import { WorkflowNodeRegistry, NODE_PREFIX } from './node-registry.service';
import { AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS } from '../automation/automation.module';

describe('WorkflowNodeRegistry', () => {
  const registry = new WorkflowNodeRegistry();

  it('generates a node for every automation trigger and action', () => {
    for (const t of AUTOMATION_TRIGGERS) {
      expect(registry.has(`${NODE_PREFIX.trigger}${t.id}`)).toBe(true);
    }
    for (const a of AUTOMATION_ACTIONS) {
      expect(registry.has(`${NODE_PREFIX.action}${a.id}`)).toBe(true);
    }
  });

  it('registers the built-in control nodes and triggers', () => {
    const expected = [
      'trigger.manual', 'trigger.scheduled', 'trigger.webhook',
      'control.condition', 'control.branch', 'control.delay', 'control.wait',
      'control.parallel', 'control.join', 'control.transform', 'control.variable',
      'control.approval', 'control.subworkflow', 'control.end',
    ];
    for (const type of expected) expect(registry.has(type)).toBe(true);
  });

  it('trigger nodes have no inputs; end node has no outputs', () => {
    expect(registry.get('trigger.manual')!.ports.inputs).toBe(0);
    expect(registry.get('control.end')!.ports.outputs).toHaveLength(0);
  });

  it('marks destructive actions and maps their permission', () => {
    const del = registry.get(`${NODE_PREFIX.action}delete_with_data`);
    expect(del?.destructive).toBe(true);
    expect(del?.requiredPermission).toBe('torrents.delete_data');
  });

  it('non-destructive action carries no destructive flag', () => {
    const scan = registry.get(`${NODE_PREFIX.action}media_scan_library`);
    expect(scan?.destructive).toBe(false);
    expect(scan?.capabilities.retry).toBe(true);
  });

  it('scheduled trigger requires an execution identity', () => {
    expect(registry.get('trigger.scheduled')!.requiredConfig).toContain('executionIdentity');
  });

  it('listByCategory returns only matching definitions', () => {
    const triggers = registry.listByCategory('trigger');
    expect(triggers.length).toBe(AUTOMATION_TRIGGERS.length + 3); // + manual/scheduled/webhook
    expect(triggers.every((d) => d.category === 'trigger')).toBe(true);
  });
});
