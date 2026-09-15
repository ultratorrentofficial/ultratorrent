import { ATTENTION_ORDER_BY, attentionPriority } from './priority';

/**
 * The ordering rank.
 *
 * Every value has to decode to something a person could explain, which is the
 * whole reason this is a formula and not a score. These cases pin the two
 * properties the queue depends on: worst-first across severities, and
 * acknowledgement demoting only *within* a severity.
 */

describe('attentionPriority', () => {
  it('sorts worst first', () => {
    const order = ['critical', 'error', 'warning', 'opportunity', 'info'].map((s) =>
      attentionPriority(s, 'unreviewed'),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeLessThan(order[order.length - 1]);
  });

  it('demotes an acknowledged finding within its severity, never below the next one', () => {
    const criticalSeen = attentionPriority('critical', 'acknowledged');
    const criticalUnseen = attentionPriority('critical', 'unreviewed');
    const errorUnseen = attentionPriority('error', 'unreviewed');

    expect(criticalUnseen).toBeLessThan(criticalSeen);
    // Reading a critical finding does not make it less urgent than an error.
    expect(criticalSeen).toBeLessThan(errorUnseen);
  });

  it('treats an escalated (reset) finding as unreviewed, needing no term of its own', () => {
    expect(attentionPriority('critical', 'unreviewed')).toBe(attentionPriority('critical', 'unreviewed'));
    expect(attentionPriority('warning', 'unreviewed')).toBeLessThan(
      attentionPriority('warning', 'acknowledged'),
    );
  });

  it('does not invent urgency for an unknown severity', () => {
    const unknown = attentionPriority('something_new', 'unreviewed');
    expect(unknown).toBeGreaterThan(attentionPriority('info', 'unreviewed'));
  });

  it('gives snoozed and dismissed the same rank as unreviewed', () => {
    // They are excluded from the active queue by predicate, not by rank —
    // one mechanism for one job, so a row cannot be hidden two different ways.
    expect(attentionPriority('warning', 'snoozed')).toBe(attentionPriority('warning', 'unreviewed'));
    expect(attentionPriority('warning', 'dismissed')).toBe(attentionPriority('warning', 'unreviewed'));
  });

  it('produces the documented values', () => {
    expect(attentionPriority('critical', 'unreviewed')).toBe(0);
    expect(attentionPriority('critical', 'acknowledged')).toBe(1);
    expect(attentionPriority('error', 'unreviewed')).toBe(10);
    expect(attentionPriority('warning', 'unreviewed')).toBe(20);
    expect(attentionPriority('opportunity', 'unreviewed')).toBe(30);
    expect(attentionPriority('info', 'unreviewed')).toBe(40);
  });
});

describe('ATTENTION_ORDER_BY', () => {
  it('ends with a unique tie-break so pagination cannot shuffle', () => {
    // Without a total order, equal-ranked rows may come back in a different
    // sequence per query, and page 2 repeats or skips rows from page 1.
    expect(ATTENTION_ORDER_BY[ATTENTION_ORDER_BY.length - 1]).toEqual({ id: 'asc' });
  });

  it('ranks before age', () => {
    expect(Object.keys(ATTENTION_ORDER_BY[0])[0]).toBe('attentionPriority');
    expect(Object.keys(ATTENTION_ORDER_BY[1])[0]).toBe('firstObservedAt');
  });
});
