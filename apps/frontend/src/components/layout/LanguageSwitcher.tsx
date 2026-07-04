import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * Compact language picker for the app shell top bar. Switches the active
 * language via i18next; the browser-language detector's localStorage cache
 * (`ultratorrent.lang`) persists the choice across reloads.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation('shell');
  // Normalize e.g. `es` → `es-PR` so the <select> always has a matching option.
  const current =
    SUPPORTED_LANGUAGES.find((l) => l.code === i18n.language)?.code ??
    SUPPORTED_LANGUAGES.find((l) => i18n.language?.startsWith(l.code.slice(0, 2)))?.code ??
    'en-US';

  return (
    <div className={cn('relative flex items-center', className)}>
      <Languages
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <select
        aria-label="Language"
        value={current}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
        className={cn(
          'h-9 appearance-none rounded-full border border-border/60 bg-white/[0.02] pl-8 pr-7 text-sm font-medium',
          'text-foreground transition-colors hover:bg-white/5',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}
