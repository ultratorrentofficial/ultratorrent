import { NewsletterUnsubscribeService } from './newsletter-unsubscribe.service';

/*
 * The token in the URL is the whole credential — a recipient has no session.
 * So the properties that matter are: it identifies exactly one address on one
 * newsletter, it cannot be forged, and it cannot be edited into someone else's.
 */

function build(recipients: string[]) {
  const state = { emails: [...recipients], events: [] as Record<string, unknown>[] };
  const svc = new NewsletterUnsubscribeService(
    {
      mediaServerNewsletter: {
        findUnique: async () => ({
          id: 'n1', name: 'Weekly', brandTitle: null, recipientEmails: state.emails,
        }),
        update: async ({ data }: { data: { recipientEmails: string[] } }) => {
          state.emails = data.recipientEmails;
          return {};
        },
      },
    } as never,
    { get: () => 'a-test-signing-secret' } as never,
    { record: async (e: Record<string, unknown>) => { state.events.push(e); } } as never,
  );
  return { svc, state };
}

describe('newsletter unsubscribe', () => {
  it('removes only the address the token was issued for', async () => {
    const { svc, state } = build(['alice@example.com', 'bob@example.com']);
    const result = await svc.unsubscribe(svc.token('n1', 'alice@example.com'));

    expect(result).toMatchObject({ ok: true, alreadyGone: false });
    expect(state.emails).toEqual(['bob@example.com']);
  });

  /*
   * The attack this design exists to prevent: a recipient editing the address in
   * their own link to remove somebody else, or to walk the list.
   */
  it('refuses a token whose address has been tampered with', async () => {
    const { svc, state } = build(['alice@example.com', 'bob@example.com']);
    const real = svc.token('n1', 'alice@example.com');
    const payload = Buffer.from('n1:bob@example.com').toString('base64url');
    const forged = `${payload}.${real.slice(real.lastIndexOf('.') + 1)}`;

    expect(await svc.unsubscribe(forged)).toEqual({ ok: false, reason: 'invalid' });
    expect(state.emails).toHaveLength(2);
  });

  it('refuses a token signed by a different instance', async () => {
    const { svc: mine } = build(['alice@example.com']);
    const { svc: theirs, state } = build(['alice@example.com']);
    // Same address, different secret would produce a different signature; here
    // we corrupt the signature directly, which is the same thing to the verifier.
    const t = mine.token('n1', 'alice@example.com');
    const broken = `${t.slice(0, t.lastIndexOf('.'))}.notasignature`;

    expect(await theirs.unsubscribe(broken)).toEqual({ ok: false, reason: 'invalid' });
    expect(state.emails).toHaveLength(1);
  });

  it('treats a second unsubscribe as success, not an error', async () => {
    const { svc, state } = build(['alice@example.com']);
    const token = svc.token('n1', 'alice@example.com');

    expect(await svc.unsubscribe(token)).toMatchObject({ alreadyGone: false });
    const again = await svc.unsubscribe(token);
    expect(again).toMatchObject({ ok: true, alreadyGone: true });
    expect(state.emails).toEqual([]);
  });

  /* describe() backs the GET page, which must never change anything. */
  it('describing a token leaves the list untouched', async () => {
    const { svc, state } = build(['alice@example.com']);
    const seen = await svc.describe(svc.token('n1', 'alice@example.com'));

    expect(seen).toMatchObject({ ok: true, email: 'alice@example.com', alreadyGone: false });
    expect(state.emails).toEqual(['alice@example.com']);
  });

  it('records the removal in the newsletter’s own activity', async () => {
    const { svc, state } = build(['alice@example.com']);
    await svc.unsubscribe(svc.token('n1', 'alice@example.com'));

    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ eventType: 'unsubscribed', newsletterId: 'n1' });
  });

  it('matches an address regardless of case', async () => {
    const { svc, state } = build(['Alice@Example.com']);
    await svc.unsubscribe(svc.token('n1', 'alice@example.com'));
    expect(state.emails).toEqual([]);
  });

  it('rejects rubbish without throwing', async () => {
    const { svc } = build(['alice@example.com']);
    for (const bad of [undefined, '', 'x', 'no-dot', '....', 'AAAA.BBBB']) {
      expect(await svc.unsubscribe(bad as string)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

/**
 * Parameter tampering.
 *
 * `@Query('t') token?: string` is a compile-time claim. Express parses
 * `?t=a&t=b` into an ARRAY and `?t[x]=1` into an OBJECT, and both reach code
 * written for a string. Arrays carry `lastIndexOf` and `slice`, so a parser
 * keeps running rather than stopping, and `Buffer.from(['a'])` coerces to zero
 * bytes instead of throwing — the old code failed closed by coincidence of
 * coercion rather than by decision, which would not survive a refactor.
 *
 * This is a public, unauthenticated endpoint reached from mail clients, so the
 * required behaviour is "not a valid link", never a crash.
 */
describe('a tampered unsubscribe parameter', () => {
  const shapes: Array<[string, unknown]> = [
    ['an array of two values', ['a', 'b']],
    ['an array whose last element makes lastIndexOf non-zero', ['a', '.']],
    ['an array containing a dot', ['.']],
    ['an empty array', []],
    ['an object', { a: 1 }],
    ['a nested object', { toString: 'x' }],
    ['a number', 12345],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
  ];

  it.each(shapes)('rejects %s rather than parsing it', (_label, value) => {
    const { svc } = build(['a@example.com']);
    expect(svc.parse(value as never)).toBeNull();
  });

  it.each(shapes)('describes %s as an invalid link, without throwing', async (_label, value) => {
    const { svc } = build(['a@example.com']);
    await expect(svc.describe(value as never)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it.each(shapes)('never unsubscribes anyone from %s', async (_label, value) => {
    const { svc, state } = build(['a@example.com', 'b@example.com']);
    await expect(svc.unsubscribe(value as never)).resolves.toEqual({ ok: false, reason: 'invalid' });
    // The list is untouched: a malformed parameter must not remove a recipient.
    expect(state.emails).toEqual(['a@example.com', 'b@example.com']);
  });

  /* The legitimate path must still work — this is the half a "fix" can break. */
  it('still accepts the token it issued', async () => {
    const { svc, state } = build(['a@example.com', 'b@example.com']);
    const token = svc.token('n1', 'a@example.com');
    expect(svc.parse(token)).toEqual({ newsletterId: 'n1', email: 'a@example.com' });
    await expect(svc.unsubscribe(token)).resolves.toMatchObject({ ok: true });
    expect(state.emails).toEqual(['b@example.com']);
  });
});
