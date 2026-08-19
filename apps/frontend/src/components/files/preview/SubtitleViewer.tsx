import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, Search, TriangleAlert } from 'lucide-react';
import type { PreviewTextEncoding } from '@ultratorrent/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { msToClock, msToShortClock, parseSubtitles } from '@/lib/subtitles';
import { TextViewer } from './TextViewer';

/**
 * Characters per second above which a cue is too fast to read comfortably.
 *
 * The usual broadcast guideline is ~17 CPS for subtitles and ~20 for captions;
 * 20 is used here so the badge marks cues that are genuinely a problem rather
 * than every slightly brisk line.
 */
const CPS_LIMIT = 20;

/** Reading speed of one cue: visible characters against seconds on screen. */
function charsPerSecond(text: string, durationMs: number): number {
  if (durationMs <= 0) return Infinity;
  return (text.replace(/\s/g, '').length / durationMs) * 1000;
}

/**
 * A reader for subtitle files that shows them as what they are — timed cues —
 * rather than as the text file they happen to be stored in.
 *
 * The raw view is still one click away, because a subtitle is *also* a text file
 * and sometimes the question is about its encoding or its markup. But the
 * questions people actually open a subtitle to answer — does it start at the
 * right time, are there gaps, is anything unreadably fast, does it cover the
 * whole film — are all questions about cues, and none of them survive being
 * printed as a wall of text.
 */
export function SubtitleViewer({
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
  const [raw, setRaw] = useState(false);

  const parsed = useMemo(() => parseSubtitles(content), [content]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? parsed.cues.filter((c) => c.text.toLowerCase().includes(q)) : parsed.cues;
  }, [parsed.cues, search]);

  const lastCueEnd = parsed.cues.length > 0 ? parsed.cues[parsed.cues.length - 1].endMs : 0;
  const fastCues = useMemo(
    () => parsed.cues.filter((c) => charsPerSecond(c.text, c.endMs - c.startMs) > CPS_LIMIT).length,
    [parsed.cues],
  );

  if (raw) {
    return (
      <div className="space-y-2">
        <Button variant="subtle" size="sm" onClick={() => setRaw(false)}>{t('preview.showCues')}</Button>
        <TextViewer
          content={content}
          encoding={encoding}
          detectedEncoding={detectedEncoding}
          truncated={truncated}
          onEncodingChange={onEncodingChange}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{parsed.format.toUpperCase()}</Badge>
        <span className="text-xs text-muted-foreground">{t('preview.cueCount', { count: parsed.cues.length })}</span>
        {lastCueEnd > 0 && (
          <span className="text-xs text-muted-foreground">{t('preview.coversUntil', { time: msToShortClock(lastCueEnd) })}</span>
        )}
        {fastCues > 0 && (
          <span className="flex items-center gap-1 text-xs text-warning">
            <Gauge className="h-3.5 w-3.5" /> {t('preview.fastCues', { count: fastCues, limit: CPS_LIMIT })}
          </span>
        )}
        <Button variant="subtle" size="sm" className="ml-auto" onClick={() => setRaw(true)}>
          {t('preview.showRaw')}
        </Button>
      </div>

      {parsed.warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <ul className="space-y-0.5 text-muted-foreground">
            {parsed.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('preview.searchCues')}
          className="h-8 pl-8 text-xs"
          aria-label={t('preview.searchCues')}
        />
      </div>

      <div className="max-h-[52vh] overflow-auto scrollbar-thin rounded-lg border border-border/60">
        {visible.length === 0 ? (
          <EmptyState title={search ? t('preview.noCueMatches') : t('preview.noCues')} />
        ) : (
          <ul className="divide-y divide-border/60">
            {/*
              Capped at 1,000 rendered cues. A feature-length subtitle runs to
              about 1,500 and the search narrows anything longer — this exists so
              a pathological file cannot lock the dialog, not as a display limit
              anyone should hit while reading.
            */}
            {visible.slice(0, 1000).map((cue) => {
              const duration = cue.endMs - cue.startMs;
              const cps = charsPerSecond(cue.text, duration);
              return (
                <li key={cue.index} className="flex gap-3 px-3 py-2 hover:bg-white/[0.02]">
                  <span className="w-8 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground/50">
                    {cue.index}
                  </span>
                  <div className="w-40 shrink-0 text-xs tabular-nums text-muted-foreground">
                    <div>{msToClock(cue.startMs)}</div>
                    <div className="text-muted-foreground/60">{msToClock(cue.endMs)}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-sm">{cue.text || <span className="italic text-muted-foreground">{t('preview.emptyCue')}</span>}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
                      <span>{(duration / 1000).toFixed(1)}s</span>
                      <span className={cn(cps > CPS_LIMIT && 'text-warning')}>
                        {Number.isFinite(cps) ? t('preview.cps', { value: Math.round(cps) }) : '—'}
                      </span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {t('preview.cueShown', { shown: Math.min(visible.length, 1000), total: parsed.cues.length })}
        {truncated && <span className="ml-2 text-warning">{t('preview.truncated')}</span>}
      </p>
    </div>
  );
}
