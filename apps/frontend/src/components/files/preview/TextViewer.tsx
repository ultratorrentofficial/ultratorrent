import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Filter, Search, Type, WrapText } from 'lucide-react';
import { PREVIEW_TEXT_ENCODINGS, type PreviewTextEncoding } from '@ultratorrent/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * How many lines are put in the DOM at once.
 *
 * A 1 MiB log is 20,000 lines, and rendering one element per line makes the
 * dialog unusable. The cap keeps the first screenful instant; the search filter
 * and the "show more" control together reach anything past it.
 */
const RENDER_CHUNK = 2000;

const ENCODING_LABELS: Record<PreviewTextEncoding, string> = {
  'utf-8': 'UTF-8',
  cp437: 'CP437 (DOS)',
  latin1: 'Latin-1',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
};

/** Split a line around every case-insensitive occurrence of `needle`. */
function highlight(line: string, needle: string): React.ReactNode {
  if (!needle) return line;
  const parts: React.ReactNode[] = [];
  const lower = line.toLowerCase();
  const target = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(target, from);
    if (at === -1) break;
    if (at > from) parts.push(line.slice(from, at));
    parts.push(
      <mark key={`${at}`} className="rounded-sm bg-primary/30 text-foreground">
        {line.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (parts.length === 0) return line;
  if (from < line.length) parts.push(line.slice(from));
  return parts;
}

/**
 * A monospace reader for NFO, subtitle-source and plain-text files.
 *
 * The controls are the ones these files actually need:
 *
 *  - **Encoding.** A scene NFO is CP437 and a European subtitle is often
 *    Latin-1. Detection gets it right most of the time and is re-decodable from
 *    the server when it does not, which is why this is a request and not a
 *    client-side re-read.
 *  - **No wrapping, by default.** NFO art is a fixed-width picture; wrapping it
 *    at the dialog edge destroys the drawing. Wrapping is one click away for the
 *    long-prose files where it helps.
 *  - **Search that filters.** In a log, "show me only the lines that match" is
 *    the useful operation, and it is also what keeps a huge file renderable.
 */
export function TextViewer({
  content,
  encoding,
  detectedEncoding,
  truncated,
  onEncodingChange,
}: {
  content: string;
  encoding: PreviewTextEncoding | null;
  detectedEncoding: PreviewTextEncoding | null;
  truncated: boolean;
  onEncodingChange: (encoding: PreviewTextEncoding) => void;
}) {
  const { t } = useTranslation('files');
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [fontSize, setFontSize] = useState(12);
  const [limit, setLimit] = useState(RENDER_CHUNK);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => content.split('\n'), [content]);

  /** Line numbers that match, kept as numbers so the gutter stays truthful. */
  const matches = useMemo(() => {
    if (!search.trim()) return null;
    const needle = search.toLowerCase();
    return lines.reduce<number[]>((acc, line, i) => {
      if (line.toLowerCase().includes(needle)) acc.push(i);
      return acc;
    }, []);
  }, [lines, search]);

  const visibleIndexes = useMemo(() => {
    const source = filterMode && matches ? matches : lines.map((_, i) => i);
    return source.slice(0, limit);
  }, [filterMode, matches, lines, limit]);

  const totalVisible = filterMode && matches ? matches.length : lines.length;
  const gutterWidth = String(lines.length).length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the text is on screen and selectable anyway */
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(RENDER_CHUNK);
              // Clearing the box leaves nothing to filter to; staying in filter
              // mode would show every line under a button claiming otherwise.
              if (e.target.value.trim() === '') setFilterMode(false);
            }}
            placeholder={t('preview.searchPlaceholder')}
            className="h-8 pl-8 text-xs"
            aria-label={t('preview.searchPlaceholder')}
          />
        </div>
        {matches && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('preview.matchCount', { count: matches.length })}
          </span>
        )}
        <Button
          variant={filterMode ? 'primary' : 'subtle'}
          size="sm"
          onClick={() => { setFilterMode((f) => !f); setLimit(RENDER_CHUNK); }}
          disabled={!matches}
          title={t('preview.filterMatches')}
        >
          <Filter className="h-3.5 w-3.5" /> {t('preview.filterMatches')}
        </Button>
        <Button variant={wrap ? 'primary' : 'subtle'} size="sm" onClick={() => setWrap((w) => !w)}>
          <WrapText className="h-3.5 w-3.5" /> {t('preview.wrap')}
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="subtle" size="icon" onClick={() => setFontSize((s) => Math.max(9, s - 1))} aria-label={t('preview.smaller')}>
            <Type className="h-3 w-3" />
          </Button>
          <Button variant="subtle" size="icon" onClick={() => setFontSize((s) => Math.min(20, s + 1))} aria-label={t('preview.larger')}>
            <Type className="h-4 w-4" />
          </Button>
        </div>
        <Select
          className="h-8 w-40 text-xs"
          value={encoding ?? 'utf-8'}
          onChange={(e) => onEncodingChange(e.target.value as PreviewTextEncoding)}
          aria-label={t('preview.encoding')}
          options={PREVIEW_TEXT_ENCODINGS.map((enc) => ({
            value: enc,
            label: enc === detectedEncoding ? t('preview.encodingDetected', { name: ENCODING_LABELS[enc] }) : ENCODING_LABELS[enc],
          }))}
        />
        <Button variant="subtle" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {t('preview.copy')}
        </Button>
      </div>

      <div className="max-h-[58vh] overflow-auto scrollbar-thin rounded-lg border border-border/60 bg-black/30">
        <pre
          className={cn('p-3 font-mono leading-relaxed', wrap && 'whitespace-pre-wrap break-words')}
          style={{ fontSize: `${fontSize}px` }}
        >
          {visibleIndexes.map((i) => (
            <div key={i} className="flex">
              <span
                className="mr-3 shrink-0 select-none text-right text-muted-foreground/40 tabular-nums"
                style={{ width: `${gutterWidth}ch` }}
              >
                {i + 1}
              </span>
              <span className={cn('min-w-0', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
                {highlight(lines[i], search) || ' '}
              </span>
            </div>
          ))}
        </pre>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{t('preview.lineCount', { shown: visibleIndexes.length, total: totalVisible })}</span>
        {visibleIndexes.length < totalVisible && (
          <Button variant="subtle" size="sm" onClick={() => setLimit((l) => l + RENDER_CHUNK)}>
            {t('preview.showMore', { count: RENDER_CHUNK })}
          </Button>
        )}
        {truncated && <span className="text-warning">{t('preview.truncated')}</span>}
      </div>
    </div>
  );
}
