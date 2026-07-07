import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

/**
 * Click-to-open help popover listing every rename-template token. Rendered next
 * to each place a naming template is configured. Token names are literal
 * template syntax (never translated); their descriptions come from i18n. Kept in
 * sync with the backend `buildTokens()` in `media-renamer.ts`.
 */
const TOKENS: { token: string; descKey: string }[] = [
  { token: '{Series Title}', descKey: 'seriesTitle' },
  { token: '{Movie Title}', descKey: 'movieTitle' },
  { token: '{Episode Title}', descKey: 'episodeTitle' },
  { token: '{season}', descKey: 'season' },
  { token: '{episode}', descKey: 'episode' },
  { token: '{episodeEnd}', descKey: 'episodeEnd' },
  { token: '{year}', descKey: 'year' },
  { token: '{Resolution}', descKey: 'resolution' },
  { token: '{Source}', descKey: 'source' },
  { token: '{Codec}', descKey: 'codec' },
  { token: '{Release Group}', descKey: 'releaseGroup' },
  { token: '{General}', descKey: 'general' },
  { token: '{ext}', descKey: 'ext' },
];

export function RenameTokensHelp() {
  const { t } = useTranslation('media');
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('renamer.tokensHelp.title')}
        title={t('renamer.tokensHelp.title')}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            className="absolute left-0 top-6 z-50 max-h-96 w-80 overflow-auto rounded-lg border border-white/10 bg-popover p-3 text-xs shadow-xl"
          >
            <div className="mb-2 font-semibold text-foreground">{t('renamer.tokensHelp.title')}</div>
            <table className="w-full border-collapse">
              <tbody>
                {TOKENS.map((x) => (
                  <tr key={x.token} className="align-top">
                    <td className="whitespace-nowrap py-0.5 pr-3 font-mono text-amber-300">{x.token}</td>
                    <td className="py-0.5 text-muted-foreground">{t(`renamer.tokensHelp.desc.${x.descKey}` as 'renamer.tokensHelp.desc.year')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 space-y-1 border-t border-white/10 pt-2 text-muted-foreground">
              <div><code className="text-foreground">{'{Token:00}'}</code> — {t('renamer.tokensHelp.padding')}</div>
              <div><code className="text-foreground">{'{name?…}'}</code> — {t('renamer.tokensHelp.optional')}</div>
              <div><code className="text-foreground">/</code> — {t('renamer.tokensHelp.folders')}</div>
            </div>
          </div>
        </>
      )}
    </span>
  );
}
