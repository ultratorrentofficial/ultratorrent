import { SubtitleSettingsService, cleanLanguageList, SUBTITLE_SETTING_KEYS } from './subtitle-settings.service';

function fakeSettings() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => void store.set(k, v),
  };
}
const audit = { record: async () => undefined };
const make = () => {
  const settings = fakeSettings();
  return { settings, svc: new SubtitleSettingsService(settings as never, audit as never) };
};

describe('cleanLanguageList', () => {
  it('lower-cases, trims, de-dupes; accepts arrays or CSV', () => {
    expect(cleanLanguageList(['EN', 'en', ' Es '])).toEqual(['en', 'es']);
    expect(cleanLanguageList('en, ES, fr')).toEqual(['en', 'es', 'fr']);
    expect(cleanLanguageList('', ['en'])).toEqual(['en']); // fallback
  });
});

describe('SubtitleSettingsService', () => {
  it('returns defaults when nothing is stored', async () => {
    const { svc } = make();
    expect(await svc.read()).toEqual({
      autoDownload: false,
      autoSync: false,
      autoScanIntervalMinutes: 0,
      defaultLanguages: ['en'],
    });
  });

  it('writes and coerces on update', async () => {
    const { svc, settings } = make();
    const out = await svc.update({
      autoDownload: true,
      autoSync: true,
      autoScanIntervalMinutes: -30 as unknown as number, // clamped to 0
      defaultLanguages: ['EN', 'es', 'es'] as string[],
    });
    expect(out).toEqual({ autoDownload: true, autoSync: true, autoScanIntervalMinutes: 0, defaultLanguages: ['en', 'es'] });
    expect(settings.store.get(SUBTITLE_SETTING_KEYS.autoDownload)).toBe(true);
  });

  it('coerces a string interval and floors it', async () => {
    const { svc } = make();
    const out = await svc.update({ autoScanIntervalMinutes: '720.9' as unknown as number });
    expect(out.autoScanIntervalMinutes).toBe(720);
  });

  it('only writes the keys provided (partial update)', async () => {
    const { svc, settings } = make();
    await svc.update({ autoDownload: true });
    expect(settings.store.has(SUBTITLE_SETTING_KEYS.autoSync)).toBe(false);
    expect((await svc.read()).autoDownload).toBe(true);
  });
});
