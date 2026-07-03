import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { CandidateResult, CheckResult, MatchType, ParsedRelease } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type BadgeTone =
  | 'default'
  | 'secondary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'info'
  | 'outline';

export const MATCH_TYPE_OPTIONS: { value: MatchType; label: string }[] = [
  { value: 'contains_text', label: 'Contains text' },
  { value: 'exact_text', label: 'Exact text' },
  { value: 'regex', label: 'Regex' },
  { value: 'wildcard', label: 'Wildcard' },
  { value: 'smart_episode_match', label: 'Smart episode match' },
  { value: 'smart_movie_match', label: 'Smart movie match' },
  { value: 'fuzzy_match', label: 'Fuzzy match' },
];

const MATCH_TYPE_LABELS = Object.fromEntries(
  MATCH_TYPE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<MatchType, string>;

export function matchTypeLabel(type: MatchType): string {
  return MATCH_TYPE_LABELS[type] ?? type;
}

const RESULT_TONE: Record<CandidateResult['result'], BadgeTone> = {
  matched: 'success',
  failed: 'destructive',
  skipped: 'secondary',
  disabled: 'warning',
};

const RESULT_LABEL: Record<CandidateResult['result'], string> = {
  matched: 'Matched',
  failed: 'Failed',
  skipped: 'Skipped',
  disabled: 'Disabled',
};

export function CandidateResultBadge({ result }: { result: CandidateResult['result'] }) {
  return (
    <Badge variant={RESULT_TONE[result]} dot>
      {RESULT_LABEL[result]}
    </Badge>
  );
}

export function resultLabel(result: CandidateResult['result']): string {
  return RESULT_LABEL[result];
}

/** Renders the per-check pass/fail breakdown for a candidate evaluation. */
export function CheckList({ checks }: { checks: CheckResult[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {checks.map((c, i) => (
        <li key={`${c.label}-${i}`} className="flex items-start gap-2 text-xs">
          {c.passed ? (
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
          ) : (
            <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
          )}
          <span className="font-medium text-foreground/90">{c.label}</span>
          {c.detail && <span className="text-muted-foreground">— {c.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Compact mono debug line summarising the parsed release metadata. */
export function ParsedDebug({ parsed }: { parsed: ParsedRelease }) {
  const parts: string[] = [];
  if (parsed.season != null)
    parts.push(`S${String(parsed.season).padStart(2, '0')}`);
  if (parsed.episode != null)
    parts.push(`E${String(parsed.episode).padStart(2, '0')}`);
  if (parsed.year != null) parts.push(`year=${parsed.year}`);
  if (parsed.resolution) parts.push(`res=${parsed.resolution}`);
  if (parsed.source) parts.push(`source=${parsed.source}`);
  if (parsed.codec) parts.push(`codec=${parsed.codec}`);
  if (parsed.languages.length) parts.push(`lang=${parsed.languages.join('/')}`);
  if (parsed.repack) parts.push('repack');
  if (parsed.proper) parts.push('proper');
  if (parsed.badQuality.length) parts.push(`bad=${parsed.badQuality.join('/')}`);

  return (
    <p className="rounded-md bg-black/30 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
      <span className="text-foreground/60">parsed:</span>{' '}
      {parts.length ? parts.join('  ') : 'no metadata detected'}
    </p>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  onRemove,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'destructive';
  onRemove?: () => void;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-white/[0.04] text-foreground/90 border-white/10',
    success: 'bg-success/10 text-success border-success/20',
    destructive: 'bg-destructive/10 text-destructive border-destructive/20',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs',
        tones[tone],
      )}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label="Remove"
          onClick={onRemove}
          className="rounded-sm text-current/70 hover:text-current"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/** Tag-style input: comma or Enter adds a term, Backspace removes the last. */
export function TermInput({
  id,
  value,
  onChange,
  placeholder,
  tone = 'neutral',
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  tone?: 'neutral' | 'success' | 'destructive';
}) {
  const [draft, setDraft] = useState('');

  const commit = (raw: string) => {
    const terms = raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (terms.length === 0) return;
    const next = [...value];
    for (const t of terms) if (!next.includes(t)) next.push(t);
    onChange(next);
    setDraft('');
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-white/[0.02] p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring">
      {value.map((t) => (
        <Chip key={t} tone={tone} onRemove={() => onChange(value.filter((x) => x !== t))}>
          {t}
        </Chip>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && draft === '' && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={value.length ? '' : placeholder}
        className="min-w-[8ch] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
      />
    </div>
  );
}
