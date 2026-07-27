import { resolveViewerName, type KnownViewer } from './viewer-name';

/**
 * Naming the viewer in a playback alert.
 *
 * The live shape on synoplex: the account list holds `Dennis Ayala`, the session
 * reports `dennis.ayala`, and the ids do not bridge them — Plex numbers the
 * server owner `1` in a session and `383757` in the account list.
 */
describe('resolveViewerName', () => {
  const known: KnownViewer[] = [
    { connectionId: null, providerUserId: '383757', userName: 'Dennis Ayala' },
    { connectionId: null, providerUserId: '19587074', userName: 'Madeline Ayala' },
    { connectionId: null, providerUserId: '24891625', userName: 'Jonathan Medina' },
  ];
  const session = (over: Partial<Parameters<typeof resolveViewerName>[1]> = {}) => ({
    connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala', ...over,
  });

  it('resolves a login to the full name the media server already knows', () => {
    expect(resolveViewerName(known, session())).toBe('Dennis Ayala');
  });

  /**
   * The shape that actually shipped and still said `dennis.ayala`: playing a
   * session mints an account row under the name the SESSION reported, so the
   * person exists twice — as their login on the connection, and as their account
   * in Plex's list. Matching by provider id landed on the shadow with total
   * confidence.
   */
  it('prefers the account record over the shadow row a session minted', () => {
    const both: KnownViewer[] = [
      { connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala', email: null },
      { connectionId: null, providerUserId: '383757', userName: 'Dennis Ayala', email: 'dennis.ayala@gmail.com' },
    ];
    // An exact id match on the shadow is still an exact match — it just is not
    // the name to show.
    expect(resolveViewerName(both, session())).toBe('Dennis Ayala');
  });

  it('leaves the resolved name alone when the duplicate carries no email either', () => {
    const both: KnownViewer[] = [
      { connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala', email: null },
      { connectionId: null, providerUserId: '383757', userName: 'Dennis Ayala', email: null },
    ];
    // Nothing distinguishes an account record from a session shadow here, so
    // there is no evidence for preferring either spelling.
    expect(resolveViewerName(both, session())).toBe('dennis.ayala');
  });

  it('refuses to upgrade when two accounts with emails normalize the same', () => {
    // Live on synoplex: two separate `Juan Hernandez` rows, both with emails.
    const twoJuans: KnownViewer[] = [
      { connectionId: 'c1', providerUserId: '5', userName: 'juan.hernandez', email: null },
      { connectionId: null, providerUserId: '6', userName: 'Juan Hernandez', email: 'a@example.com' },
      { connectionId: null, providerUserId: '7', userName: 'Juan Hernandez', email: 'b@example.com' },
    ];
    expect(
      resolveViewerName(twoJuans, session({ userName: 'juan.hernandez', providerUserId: '5' })),
    ).toBe('juan.hernandez');
  });

  it('prefers an exact id on the same connection over any name matching', () => {
    const scoped: KnownViewer[] = [
      { connectionId: 'c1', providerUserId: '77', userName: 'Maria Ayala' },
      ...known,
    ];
    expect(resolveViewerName(scoped, session({ providerUserId: '77' }))).toBe('Maria Ayala');
  });

  it('ignores an id that belongs to a DIFFERENT connection', () => {
    const scoped: KnownViewer[] = [
      { connectionId: 'other', providerUserId: '1', userName: 'Someone Else' },
      ...known,
    ];
    // Two servers number their owners independently; id 1 on one is not id 1 on
    // the other. Falls through to the name, which does resolve.
    expect(resolveViewerName(scoped, session())).toBe('Dennis Ayala');
  });

  it('resolves a handle by provider id even when the account list is unscoped', () => {
    // The live shape: `jonathanxir` plays under Plex account 24891625, which the
    // account list calls `Jonathan Medina`. The name alone would never match; the
    // id does, and a null connectionId means unscoped, not "another server".
    expect(
      resolveViewerName(known, session({ userName: 'jonathanxir', providerUserId: '24891625' })),
    ).toBe('Jonathan Medina');
  });

  it('refuses an unscoped id offered by more than one account', () => {
    // Every Plex server numbers its own owner `1`, so with two connected servers
    // that id identifies nobody.
    const twoOwners: KnownViewer[] = [
      { connectionId: null, providerUserId: '1', userName: 'Dennis Ayala' },
      { connectionId: null, providerUserId: '1', userName: 'Someone Else' },
    ];
    expect(resolveViewerName(twoOwners, session({ userName: 'guest' }))).toBe('guest');
  });

  it('keeps a handle that is only a PREFIX of a known name', () => {
    // `jonathanxir` sits inside `jonathanxirizarry2014@gmail.com`. With no id to
    // go on, a shared start is not an identity, and a wrong name on someone's
    // viewing is worse than a handle.
    expect(
      resolveViewerName(known, session({ userName: 'jonathanxir', providerUserId: null })),
    ).toBe('jonathanxir');
  });

  it('refuses to choose when two accounts normalize the same way', () => {
    const ambiguous: KnownViewer[] = [
      { connectionId: null, providerUserId: '11', userName: 'Dennis Ayala' },
      { connectionId: null, providerUserId: '22', userName: 'D.Ennis-Ayala' },
    ];
    // No id to settle it (the owner is `1`, which neither account carries), and
    // both names reduce to `dennisayala`.
    expect(resolveViewerName(ambiguous, session())).toBe('dennis.ayala');
  });

  it('leaves an unknown viewer, and a nameless one, exactly as found', () => {
    expect(resolveViewerName(known, session({ userName: 'a-guest' }))).toBe('a-guest');
    expect(resolveViewerName(known, session({ userName: null }))).toBeNull();
    expect(resolveViewerName([], session())).toBe('dennis.ayala');
  });

  it('passes through a name that already matches an account', () => {
    expect(resolveViewerName(known, session({ userName: 'Madeline Ayala' }))).toBe('Madeline Ayala');
  });
});
