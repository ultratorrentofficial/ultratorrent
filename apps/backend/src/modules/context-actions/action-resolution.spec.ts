/**
 * The applicability rule, tested where Jest runs.
 *
 * `appliesTo` lives in `@ultratorrent/shared` because the client builds the
 * toolbar with it and the server validates a dispatch with it — one definition,
 * so a rendered action cannot 400 on click. `packages/shared` has no test
 * runner of its own, so its rules are pinned from the backend suite, which
 * consumes the built package exactly as production code does.
 */
import {
  ACTION_GROUP_ORDER,
  appliesTo,
  arityOf,
  availabilityOf,
  resolveActions,
  selectionTypes,
  type EntityRef,
  type ResolvedAction,
} from '@ultratorrent/shared';

function action(over: Partial<ResolvedAction> = {}): ResolvedAction {
  return {
    id: 'media.metadata.refresh',
    group: 'metadata',
    entityTypes: ['media_item'],
    arity: 'any',
    operationsOnly: false,
    destructive: false,
    whenUnavailable: 'hide',
    async: true,
    order: 100,
    ...over,
  };
}

const items = (n: number): EntityRef[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'media_item' as const, id: `i${i}` }));

describe('arityOf', () => {
  it('maps a count onto the arity it satisfies', () => {
    expect(arityOf(0)).toBe('none');
    expect(arityOf(1)).toBe('single');
    expect(arityOf(2)).toBe('multi');
    expect(arityOf(900)).toBe('multi');
  });
});

describe('selectionTypes', () => {
  it('deduplicates while preserving what is present', () => {
    expect(selectionTypes([...items(3)])).toEqual(['media_item']);
    expect(
      selectionTypes([
        { type: 'media_item', id: 'a' },
        { type: 'tv_show', id: 'b' },
        { type: 'media_item', id: 'c' },
      ]),
    ).toEqual(['media_item', 'tv_show']);
  });
});

describe('appliesTo — arity', () => {
  it('offers a global action only with nothing selected', () => {
    const scan = action({ arity: 'none', entityTypes: ['library'] });
    expect(appliesTo(scan, { selection: [] })).toBe(true);
    expect(appliesTo(scan, { selection: items(1) })).toBe(false);
  });

  it('offers a single-selection action for exactly one', () => {
    const a = action({ arity: 'single' });
    expect(appliesTo(a, { selection: items(1) })).toBe(true);
    expect(appliesTo(a, { selection: items(2) })).toBe(false);
    expect(appliesTo(a, { selection: [] })).toBe(false);
  });

  it('offers a multi action only for more than one', () => {
    const a = action({ arity: 'multi' });
    expect(appliesTo(a, { selection: items(2) })).toBe(true);
    expect(appliesTo(a, { selection: items(1) })).toBe(false);
  });

  it('never offers an entity action with an empty selection, even at arity "any"', () => {
    // The trap `any` invites: an action over entities needs entities, and only
    // an explicitly global action runs without them. Offering "Delete" on an
    // empty selection is how a toolbar acts on nothing, or on everything.
    expect(appliesTo(action({ arity: 'any' }), { selection: [] })).toBe(false);
  });
});

describe('appliesTo — entity types', () => {
  it('requires EVERY selected type to be supported', () => {
    const a = action({ entityTypes: ['media_item'] });
    const mixed: EntityRef[] = [
      { type: 'media_item', id: 'a' },
      { type: 'torrent', id: 'b' },
    ];
    // The important case: acting on the media item and silently skipping the
    // torrent is worse than not offering the action at all.
    expect(appliesTo(a, { selection: mixed })).toBe(false);
  });

  it('offers an action that spans every type in a mixed selection', () => {
    const a = action({ entityTypes: ['media_item', 'torrent'], arity: 'any' });
    expect(
      appliesTo(a, {
        selection: [
          { type: 'media_item', id: 'a' },
          { type: 'torrent', id: 'b' },
        ],
      }),
    ).toBe(true);
  });
});

describe('appliesTo — Operations Mode', () => {
  const advanced = action({ id: 'media.maintenance.rename', operationsOnly: true });

  it('withholds an operations-only action in Browse Mode', () => {
    expect(appliesTo(advanced, { selection: items(1) })).toBe(false);
  });

  it('reveals it in Operations Mode', () => {
    expect(appliesTo(advanced, { selection: items(1), operationsMode: true })).toBe(true);
  });

  it('does not turn Operations Mode into a permission bypass', () => {
    // Operations Mode is disclosure, not authorisation: an action the server
    // withheld never reached the client, so no mode can bring it back.
    const withheld: ResolvedAction[] = [];
    expect(resolveActions(withheld, { selection: items(1), operationsMode: true })).toEqual([]);
  });
});

describe('availabilityOf — selection ceiling', () => {
  it('blocks a selection past the action\'s maximum', () => {
    // Mirrors the server's MAX_BULK_IDS so the UI refuses before the request
    // rather than after the 400.
    const a = action({ maxSelection: 1000 });
    expect(availabilityOf(a, { selection: items(1000) })).toEqual({ enabled: true });
    expect(availabilityOf(a, { selection: items(1001) })).toEqual({
      enabled: false,
      reason: 'max_selection',
    });
  });

  it('still counts the action as applicable, so it can explain itself', () => {
    // The distinction that matters: over the ceiling the action is *blocked*,
    // not *irrelevant*. A surface that opted into `disable` can therefore say
    // "too many selected" instead of silently vanishing.
    const a = action({ maxSelection: 2, whenUnavailable: 'disable' });
    expect(appliesTo(a, { selection: items(5) })).toBe(true);
  });
});

describe('availabilityOf — advertised entity capabilities', () => {
  const cancel = action({
    id: 'jobs.cancel',
    group: 'maintenance',
    entityTypes: ['job'],
    requiresEntityCapability: 'cancellable',
  });

  const job = (id: string, caps: string[]): EntityRef => ({ type: 'job', id, capabilities: caps });

  it('enables the action when every selected entity advertises the capability', () => {
    expect(
      availabilityOf(cancel, { selection: [job('a', ['cancellable']), job('b', ['cancellable'])] }),
    ).toEqual({ enabled: true });
  });

  it('blocks it when even one entity does not', () => {
    // Cancelling the two that can and skipping the third is acting on less than
    // the selection without saying so.
    expect(
      availabilityOf(cancel, {
        selection: [job('a', ['cancellable']), job('b', ['retryable'])],
      }),
    ).toEqual({ enabled: false, reason: 'entity_capability' });
  });

  it('blocks it for an entity advertising nothing', () => {
    expect(availabilityOf(cancel, { selection: [{ type: 'job', id: 'a' }] })).toEqual({
      enabled: false,
      reason: 'entity_capability',
    });
  });

  it('does not constrain an action that requires no capability', () => {
    // An entity advertising nothing must not thereby lose every action, or the
    // common case would need boilerplate on every row.
    expect(availabilityOf(action(), { selection: [{ type: 'media_item', id: 'x' }] })).toEqual({
      enabled: true,
    });
  });
});

describe('hide versus disable', () => {
  const blocked = { selection: [{ type: 'job' as const, id: 'a', capabilities: [] }] };

  it('drops a blocked action that asked to be hidden', () => {
    const a = action({
      entityTypes: ['job'],
      requiresEntityCapability: 'cancellable',
      whenUnavailable: 'hide',
    });
    expect(resolveActions([a], blocked)).toEqual([]);
  });

  it('keeps a blocked action that asked to explain itself, marked disabled', () => {
    const a = action({
      entityTypes: ['job'],
      requiresEntityCapability: 'cancellable',
      whenUnavailable: 'disable',
    });
    const [group] = resolveActions([a], blocked);
    expect(group.actions).toHaveLength(1);
    expect(group.actions[0].enabled).toBe(false);
    expect(group.actions[0].reason).toBe('entity_capability');
  });

  it('never shows an inapplicable action, whatever it asked for', () => {
    // Wrong entity type is irrelevance, not blockage — `disable` must not
    // resurrect an action that has no business being on this surface.
    const a = action({ entityTypes: ['torrent'], whenUnavailable: 'disable' });
    expect(resolveActions([a], { selection: items(1) })).toEqual([]);
  });
});

describe('resolveActions', () => {
  it('groups, orders and drops empty groups', () => {
    const all = [
      action({ id: 'z.maintenance', group: 'maintenance', order: 10 }),
      action({ id: 'a.metadata', group: 'metadata', order: 20 }),
      action({ id: 'b.metadata', group: 'metadata', order: 10 }),
    ];
    const groups = resolveActions(all, { selection: items(1) });

    // Groups follow the platform-wide order, not registration order.
    expect(groups.map((g) => g.group)).toEqual(['metadata', 'maintenance']);
    // Within a group, `order` wins.
    expect(groups[0].actions.map((v) => v.action.id)).toEqual(['b.metadata', 'a.metadata']);
    // An empty group heading would advertise a category with nothing in it.
    expect(groups.every((g) => g.actions.length > 0)).toBe(true);
  });

  it('breaks ties on id so the toolbar is stable between renders', () => {
    const all = [
      action({ id: 'metadata.zebra', order: 5 }),
      action({ id: 'metadata.alpha', order: 5 }),
    ];
    const first = resolveActions(all, { selection: items(1) })[0].actions.map((v) => v.action.id);
    const second = resolveActions([...all].reverse(), { selection: items(1) })[0].actions.map(
      (v) => v.action.id,
    );
    expect(first).toEqual(['metadata.alpha', 'metadata.zebra']);
    expect(first).toEqual(second);
  });

  it('returns nothing rather than an empty shell when no action applies', () => {
    expect(resolveActions([action({ arity: 'single' })], { selection: items(5) })).toEqual([]);
  });

  it('only ever emits known groups', () => {
    const groups = resolveActions([action()], { selection: items(1) });
    for (const g of groups) expect(ACTION_GROUP_ORDER).toContain(g.group);
  });
});
