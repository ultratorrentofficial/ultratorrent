import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('rss');
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
      toast.error(t('smart.toast.nothingToAnalyze'), t('smart.toast.nothingToAnalyzeBody'));
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
      toast.error(t('smart.toast.analyzeFailed'), err instanceof ApiError ? err.message : undefined);
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
      toast.error(t('smart.toast.nothingToTest'), t('smart.toast.nothingToTestBody'));
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
      toast.error(t('smart.toast.testFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!analysis) return;
    const included = candidates.filter((c) => c.included);
    if (included.length === 0) {
      toast.error(t('smart.toast.noCandidatesSelected'), t('smart.toast.noCandidatesSelectedBody'));
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
        t('smart.toast.candidatesAdded'),
        t('smart.toast.candidatesAddedBody', { count: recommendedCandidates.length }),
      );
      onApplied();
    } catch (err) {
      toast.error(t('smart.toast.saveFailed'), err instanceof ApiError ? err.message : undefined);
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
              {t('smart.infoBefore')} <strong>{t('smart.infoBold')}</strong> {t('smart.infoAfter')}
            </span>
          </div>

          <div>
            <Label htmlFor="smart-name">{t('smart.pasteLabel')}</Label>
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
                <Sparkles className="h-4 w-4" /> {t('smart.analyze')}
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
              <Label htmlFor="smart-samples">{t('smart.sampleLabel')}</Label>
              <Textarea
                id="smart-samples"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                placeholder={`${PLACEHOLDER}\nThe.Example.Show.S02E05.720p.HDTV.x264-OTHER`}
                className="min-h-[90px] font-mono text-xs"
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {t('smart.sampleHint')}
                </p>
                <Button variant="secondary" onClick={runTest} loading={testing} className="shrink-0">
                  <ListChecks className="h-4 w-4" /> {t('smart.testCandidates')}
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
              <Save className="h-4 w-4" /> {t('smart.saveToRule')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function MetadataPreview({ analysis }: { analysis: SmartAnalyzeResult }) {
  const { t } = useTranslation('rss');
  const meta = analysis.parsedMetadata;
  const score = analysis.confidenceScore;

  const rows: { label: string; value: string }[] = [];
  if (meta.title) rows.push({ label: t('smart.metadata.row.title'), value: meta.title });
  rows.push({
    label: t('smart.metadata.row.contentType'),
    value: t(`smart.contentType.${meta.contentType}` as 'smart.contentType.movie'),
  });
  if (meta.season != null || meta.episode != null) {
    const s = meta.season != null ? `S${String(meta.season).padStart(2, '0')}` : '';
    const e = meta.episode != null ? `E${String(meta.episode).padStart(2, '0')}` : '';
    rows.push({ label: t('smart.metadata.row.seasonEpisode'), value: `${s}${e}` || '—' });
  }
  if (meta.absoluteEpisode != null)
    rows.push({ label: t('smart.metadata.row.absoluteEpisode'), value: String(meta.absoluteEpisode) });
  if (meta.airDate) rows.push({ label: t('smart.metadata.row.airDate'), value: meta.airDate });
  if (meta.year != null) rows.push({ label: t('smart.metadata.row.year'), value: String(meta.year) });
  if (meta.resolution) rows.push({ label: t('smart.metadata.row.resolution'), value: meta.resolution });
  if (meta.source) rows.push({ label: t('smart.metadata.row.source'), value: meta.source });
  if (meta.codec) rows.push({ label: t('smart.metadata.row.codec'), value: meta.codec });
  if (meta.releaseGroup) rows.push({ label: t('smart.metadata.row.releaseGroup'), value: meta.releaseGroup });

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        {/* Confidence */}
        <div>
          <div className="flex items-end justify-between">
            <p className="text-sm font-semibold">{t('smart.metadata.confidence')}</p>
            <span className={cn('text-2xl font-bold tabular-nums', scoreTone(score))}>
              {Math.round(score)}
              <span className="text-base text-muted-foreground">{t('smart.metadata.outOf')}</span>
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
          <p className="mb-2 text-sm font-semibold">{t('smart.metadata.extracted')}</p>
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
              {meta.repack && <Chip tone="success">{t('smart.metadata.repack')}</Chip>}
              {meta.proper && <Chip tone="success">{t('smart.metadata.proper')}</Chip>}
            </div>
          )}
        </div>

        {/* Explanations */}
        {analysis.explanations.length > 0 && (
          <div>
            <p className="mb-1.5 text-sm font-semibold">{t('smart.metadata.why')}</p>
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
  const { t } = useTranslation('rss');
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="text-sm font-semibold">{t('smart.editor.title')}</p>
          <p className="text-xs text-muted-foreground">
            {t('smart.editor.hint')}
          </p>
        </div>

        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('smart.editor.none')}</p>
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
                <Badge variant="secondary">{matchTypeLabel(t, c.matchType as MatchType)}</Badge>
                <Badge variant={CONFIDENCE_VARIANT[c.confidence]} dot>
                  {t(`smart.confidence.${c.confidence}` as 'smart.confidence.high')}
                </Badge>
                <div className="ml-auto flex items-center gap-1">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={c.included}
                      onChange={(e) => onUpdate(i, { included: e.target.checked })}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    {t('smart.editor.include')}
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('smart.editor.removeCandidate')}
                    onClick={() => onRemove(i)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`smart-cand-name-${i}`}>{t('smart.editor.name')}</Label>
                  <Input
                    id={`smart-cand-name-${i}`}
                    value={c.name}
                    onChange={(e) => onUpdate(i, { name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`smart-cand-pattern-${i}`}>{t('smart.editor.pattern')}</Label>
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
  const { t } = useTranslation('rss');
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">{t('smart.results.title')}</p>
          <Badge variant={result.recommendation.action === 'download' ? 'success' : 'secondary'} dot>
            {result.recommendation.action === 'download'
              ? t('smart.results.recommendedDownload', {
                  name: result.recommendation.matchedCandidateName ?? t('smart.results.downloadFallback'),
                })
              : t('smart.results.recommendedNoAction')}
          </Badge>
        </div>
        {result.results.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('smart.results.none')}</p>
        ) : (
          result.results.map((r, i) => <PreferenceRow key={`${r.title}-${i}`} item={r} />)
        )}
      </CardContent>
    </Card>
  );
}
