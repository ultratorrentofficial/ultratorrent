import { SubtitleAutomationActions } from './subtitle-automation.actions';

describe('SubtitleAutomationActions', () => {
  const makeActions = () => {
    const scanLibrary = jest.fn().mockResolvedValue({ scanned: 1, gaps: 0, downloaded: 0 });
    const search = jest.fn().mockResolvedValue({ candidates: [{ id: 'c1', language: 'en', score: 92, scoreTier: 'auto' }] });
    const downloadCandidate = jest.fn().mockResolvedValue({ installed: true });
    const actions = new SubtitleAutomationActions(
      { search, downloadCandidate } as never,
      { scanLibrary } as never,
    );
    return { actions, scanLibrary, search, downloadCandidate };
  };

  it('subtitle_scan_missing scans the library from params', async () => {
    const { actions, scanLibrary } = makeActions();
    await actions.execute('subtitle_scan_missing', { libraryId: 'lib-1' });
    expect(scanLibrary).toHaveBeenCalledWith('lib-1');
  });

  it('subtitle_scan_missing falls back to the context libraryId', async () => {
    const { actions, scanLibrary } = makeActions();
    await actions.execute('subtitle_scan_missing', {}, { libraryId: 'lib-ctx' });
    expect(scanLibrary).toHaveBeenCalledWith('lib-ctx');
  });

  it('subtitle_download searches and installs the best acceptable candidate', async () => {
    const { actions, search, downloadCandidate } = makeActions();
    await actions.execute('subtitle_download', {}, { itemId: 'item-1', languages: 'en,es' });
    expect(search).toHaveBeenCalledWith('item-1', { languages: ['en', 'es'] }, {});
    expect(downloadCandidate).toHaveBeenCalledWith('c1', {});
  });

  it('subtitle_download is a no-op without an item id', async () => {
    const { actions, search } = makeActions();
    await actions.execute('subtitle_download', {});
    expect(search).not.toHaveBeenCalled();
  });

  it('ignores an unknown action type', async () => {
    const { actions, scanLibrary, search } = makeActions();
    await actions.execute('nonsense', {});
    expect(scanLibrary).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});
