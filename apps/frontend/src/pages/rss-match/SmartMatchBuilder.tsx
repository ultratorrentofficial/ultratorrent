import { useState } from 'react';
import {
  Check,
  Info,
  ListChecks,
  Save,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  ApiError,
  api,
  type GeneratedCandidate,
  type MatchType,
  type ParsedTorrentMeta,
  type SmartAnalyzeResult,
  type SmartTestResult,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Chip, matchTypeLabel } from './shared';
import { PreferenceRow } from './TestingPanel';

interface EditableCandidate extends GeneratedCandidate {
  included: boolean;
}

const PLACEHOLDER = 'The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP';

const CONTENT_TYPE_LABELS: Record<ParsedTorrentMeta['contentType'], string> = {
  tv_episode: 'TV episode',
  anime_episode: 'Anime episode',
  movie: 'Movie',
  daily: 'Daily',
  unknown: 'Unknown',
};

const CONFIDENCE_VARIANT: Record<GeneratedCandidate['confidence'], 'success' | 'warning' | 'secondary'> = {
  high: 'success',
  medium: 'warning',
  low: 'secondary',
};

function scoreTone(score: number): string {
  if (score >= 80) return 'text-success';
  if (score >= 50) return 'text-warning';
  return 'text-destructive';
}

function scoreBar(score: number): string {
  if (score >= 80) return 'bg-success';
  if (score >= 50) return 'bg-warning';
  return 'bg-destructive';
}

export function SmartMatchBuilder({
  ruleId,
  onApplied,
}: {
  ruleId: string;
  /** Called after candidates are appended so the parent can switch tabs. */
  onApplied: () => void;
}) {
  const toast = useToast();
  const [torrentName, setTorrentName] = useState('');
  const [analysis, setAnalysis] = useState<SmartAnalyzeResult | null>(null);
  const [candidates, setCandidates] = useState<EditableCandidate[]>([]);
  const [userEdited, setUserEdited] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const [sampleText, setSampleText] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SmartTestResult | null>(null);

  const [saving, setSaving] = useState(false);

  const analyze = async () => {
    const name = torrentName.trim();
    if (!name) {
      toast.error('Nothing to analyze', 'Paste a torrent release name first.');
      return;
    }
    setAnalyzing(true);
    setTestResult(null);
    try {
      const res = await api.rss.analyzeSmartMatch(name);
      setAnalysis(res);
      setCandidates(res.recommendedCandidates.map((c) => ({ ...c, included: true })));
      setUserEdited(false);
    } catch (err) {
      toast.error('Could not analyze', err instanceof ApiError ? err.message : undefined);
    } finally {
      setAnalyzing(false);
    }
  };

  const updateCandidate = (index: number, patch: Partial<EditableCandidate>) => {
    setCandidates((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    setUserEdited(true);
  };

  const removeCandidate = (index: number) => {
    setCandidates((prev) => prev.filter((_, i) => i !== index));
    setUserEdited(true);
  };

  const runTest = async () => {
    const name = torrentName.trim();
    if (!name) {
      toast.error('Nothing to test', 'Paste a torrent release name first.');
      return;
    }
    const sampleItems = sampleText
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    setTesting(true);
    try {
      const res = await api.rss.testSmartMatch({
        torrentName: name,
        ...(sampleItems.length ? { sampleItems } : {}),
      });
      setTestResult(res);
    } catch (err) {
      toast.error('Test failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!analysis) return;
    const included = candidates.filter((c) => c.included);
    if (included.length === 0) {
      toast.error('No candidates selected', 'Include at least one candidate to save.');
      return;
    }
    const recommendedCandidates: GeneratedCandidate[] = included.map((c) => ({
      name: c.name,
      description: c.description,
      matchType: c.matchType,
      pattern: c.pattern,
      requiredTerms: c.requiredTerms,
      excludedTerms: c.excludedTerms,
      qualityRules: c.qualityRules,
      confidence: c.confidence,
    }));
    setSaving(true);
    try {
      await api.rss.applySmartMatch(ruleId, {
        sourceName: analysis.sourceName,
        parsedMetadata: analysis.parsedMetadata,
        confidenceScore: analysis.confidenceScore,
        recommendedCandidates,
        userEdited,
      });
      toast.success(
        'Candidates added',
        `Appended ${recommendedCandidates.length} candidate${recommendedCandidates.length === 1 ? '' : 's'} to the rule.`,
      );
      onApplied();
    } catch (err) {
      toast.error('Could not save candidates', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-start gap-2 rounded-md bg-info/10 px-3 py-2 text-xs text-info">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Smart Build analyzes a release name and proposes ranked match candidates. Saving{' '}
              <strong>appends</strong> them to this rule — it never replaces existing candidates, and
              you can edit everything before saving.
            </span>
          </div>

          <div>
            <Label htmlFor="smart-name">Paste torrent release name</Label>
            <div className="mt-1 flex gap-2">
              <Input
                id="smart-name"
                value={torrentName}
                onChange={(e) => setTorrentName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void analyze();
                }}
                placeholder={PLACEHOLDER}
                className="font-mono"
              />
              <Button onClick={analyze} loading={analyzing} className="shrink-0">
                <Sparkles className="h-4 w-4" /> Analyze
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {analysis && (
        <>
          <MetadataPreview analysis={analysis} />
          <CandidatesEditor
            candidates={candidates}
            onUpdate={updateCandidate}
            onRemove={removeCandidate}
          />

          {/* Test */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <Label htmlFor="smart-samples">Sample titles to test against (optional, one per line)</Label>
              <Textarea
                id="smart-samples"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                placeholder={`${PLACEHOLDER}\nThe.Example.Show.S02E05.720p.HDTV.x264-OTHER`}
                className="min-h-[90px] font-mono text-xs"
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Tests the generated candidates against the release name and any sample titles.
                </p>
                <Button variant="secondary" onClick={runTest} loading={testing} className="shrink-0">
                  <ListChecks className="h-4 w-4" /> Test candidates
                </Button>
              </div>
            </CardContent>
          </Card>

          {testResult && <TestResults result={testResult} />}

          <div className="flex items-center justify-end gap-2">
            <Button
              onClick={save}
              loading={saving}
              disabled={candidates.filter((c) => c.included).length === 0}
            >
              <Save className="h-4 w-4" /> Save to rule
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function MetadataPreview({ analysis }: { analysis: SmartAnalyzeResult }) {
  const meta = analysis.parsedMetadata;
  const score = analysis.confidenceScore;

  const rows: { label: string; value: string }[] = [];
  if (meta.title) rows.push({ label: 'Title', value: meta.title });
  rows.push({ label: 'Content type', value: CONTENT_TYPE_LABELS[meta.contentType] });
  if (meta.season != null || meta.episode != null) {
    const s = meta.season != null ? `S${String(meta.season).padStart(2, '0')}` : '';
    const e = meta.episode != null ? `E${String(meta.episode).padStart(2, '0')}` : '';
    rows.push({ label: 'Season / Episode', value: `${s}${e}` || '—' });
  }
  if (meta.absoluteEpisode != null)
    rows.push({ label: 'Absolute episode', value: String(meta.absoluteEpisode) });
  if (meta.airDate) rows.push({ label: 'Air date', value: meta.airDate });
  if (meta.year != null) rows.push({ label: 'Year', value: String(meta.year) });
  if (meta.resolution) rows.push({ label: 'Resolution', value: meta.resolution });
  if (meta.source) rows.push({ label: 'Source', value: meta.source });
  if (meta.codec) rows.push({ label: 'Codec', value: meta.codec });
  if (meta.releaseGroup) rows.push({ label: 'Release group', value: meta.releaseGroup });

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        {/* Confidence */}
        <div>
          <div className="flex items-end justify-between">
            <p className="text-sm font-semibold">Confidence</p>
            <span className={cn('text-2xl font-bold tabular-nums', scoreTone(score))}>
              {Math.round(score)}
              <span className="text-base text-muted-foreground">/100</span>
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={cn('h-full rounded-full transition-all', scoreBar(score))}
              style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
            />
          </div>
        </div>

        {/* Extracted metadata */}
        <div>
          <p className="mb-2 text-sm font-semibold">Extracted metadata</p>
          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-3 text-sm">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="truncate font-medium">{r.value}</dd>
              </div>
            ))}
          </dl>

          {(meta.audio.length > 0 ||
            meta.hdr.length > 0 ||
            meta.languages.length > 0 ||
            meta.proper ||
            meta.repack) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {meta.audio.map((a) => (
                <Chip key={`audio-${a}`}>{a}</Chip>
              ))}
              {meta.hdr.map((h) => (
                <Chip key={`hdr-${h}`} tone="success">
                  {h}
                </Chip>
              ))}
              {meta.languages.map((l) => (
                <Chip key={`lang-${l}`}>{l}</Chip>
              ))}
              {meta.repack && <Chip tone="success">repack</Chip>}
              {meta.proper && <Chip tone="success">proper</Chip>}
            </div>
          )}
        </div>

        {/* Explanations */}
        {analysis.explanations.length > 0 && (
          <div>
            <p className="mb-1.5 text-sm font-semibold">Why</p>
            <ul className="space-y-1">
              {analysis.explanations.map((ex, i) => (
                <li key={`${ex.field}-${i}`} className="flex items-start gap-2 text-xs">
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                  <span>
                    <span className="font-medium text-foreground/90">{ex.field}</span>
                    {ex.value && <span className="font-mono text-muted-foreground"> = {ex.value}</span>}
                    {ex.reason && <span className="text-muted-foreground"> — {ex.reason}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Warnings */}
        {analysis.warnings.length > 0 && (
          <div className="space-y-1.5 rounded-md border border-warning/30 bg-warning/10 p-3">
            {analysis.warnings.map((w, i) => (
              <p key={i} className="flex items-start gap-2 text-xs text-warning">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{w}</span>
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CandidatesEditor({
  candidates,
  onUpdate,
  onRemove,
}: {
  candidates: EditableCandidate[];
  onUpdate: (index: number, patch: Partial<EditableCandidate>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="text-sm font-semibold">Generated candidates</p>
          <p className="text-xs text-muted-foreground">
            Edit names and patterns, toggle which to include, or remove any before saving. They are
            appended in this order of preference.
          </p>
        </div>

        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No candidates remaining.</p>
        ) : (
          candidates.map((c, i) => (
            <div
              key={i}
              className={cn(
                'rounded-md border p-3 transition-colors',
                c.included ? 'border-border/60' : 'border-border/30 opacity-50',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-white/[0.04] text-xs font-semibold tabular-nums">
                  {i + 1}
                </span>
                <Badge variant="secondary">{matchTypeLabel(c.matchType as MatchType)}</Badge>
                <Badge variant={CONFIDENCE_VARIANT[c.confidence]} dot>
                  {c.confidence}
                </Badge>
                <div className="ml-auto flex items-center gap-1">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={c.included}
                      onChange={(e) => onUpdate(i, { included: e.target.checked })}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    include
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove candidate"
                    onClick={() => onRemove(i)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`smart-cand-name-${i}`}>Name</Label>
                  <Input
                    id={`smart-cand-name-${i}`}
                    value={c.name}
                    onChange={(e) => onUpdate(i, { name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`smart-cand-pattern-${i}`}>Pattern</Label>
                  <Input
                    id={`smart-cand-pattern-${i}`}
                    value={c.pattern}
                    onChange={(e) => onUpdate(i, { pattern: e.target.value })}
                    className="font-mono"
                  />
                </div>
              </div>

              {c.description && (
                <p className="mt-2 text-xs text-muted-foreground">{c.description}</p>
              )}

              {(c.requiredTerms.length > 0 || c.excludedTerms.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {c.requiredTerms.map((t) => (
                    <Chip key={`req-${t}`} tone="success">
                      +{t}
                    </Chip>
                  ))}
                  {c.excludedTerms.map((t) => (
                    <Chip key={`exc-${t}`} tone="destructive">
                      −{t}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function TestResults({ result }: { result: SmartTestResult }) {
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">Test results</p>
          <Badge variant={result.recommendation.action === 'download' ? 'success' : 'secondary'} dot>
            {result.recommendation.action === 'download'
              ? `Recommended: ${result.recommendation.matchedCandidateName ?? 'download'}`
              : 'Recommended: no action'}
          </Badge>
        </div>
        {result.results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No titles were evaluated.</p>
        ) : (
          result.results.map((r, i) => <PreferenceRow key={`${r.title}-${i}`} item={r} />)
        )}
      </CardContent>
    </Card>
  );
}
