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
