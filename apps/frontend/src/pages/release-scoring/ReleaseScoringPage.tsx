import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  Award,
  Gauge,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  ApiError,
  api,
  type ReleaseDecision,
  type ReleaseScoreInput,
  type ReleaseScoreResult,
  type ReleaseTestRuleResult,
  type TrackerHealth,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

const TRACKER_HEALTH_VALUES = ['', 'healthy', 'degraded', 'dead'] as const;
const TRACKER_HEALTH_KEYS: Record<string, string> = {
  '': 'unspecified',
  healthy: 'healthy',
  degraded: 'degraded',
  dead: 'dead',
};

function decisionVariant(decision: ReleaseDecision): BadgeVariant {
  switch (decision) {
    case 'download':
      return 'success';
    case 'review':
      return 'info';
    case 'skip':
      return 'warning';
    case 'reject':
      return 'destructive';
    default:
      return 'secondary';
  }
}

function scoreTone(score: number): string {
  if (score >= 75) return 'text-success';
  if (score >= 50) return 'text-info';
  if (score >= 25) return 'text-warning';
  return 'text-destructive';
}

interface ScoringForm {
  title: string;
  preferredResolution: string;
  preferredCodec: string;
  preferredSources: string[];
  preferredGroups: string[];
  avoidedGroups: string[];
  excludedTerms: string[];
  seeders: string;
  trackerHealth: string;
  duplicateRisk: boolean;
  minScore: string;
}

const EMPTY_FORM: ScoringForm = {
  title: '',
  preferredResolution: '',
  preferredCodec: '',
  preferredSources: [],
  preferredGroups: [],
  avoidedGroups: [],
  excludedTerms: [],
  seeders: '',
  trackerHealth: '',
  duplicateRisk: false,
  minScore: '70',
};

export function ReleaseScoringPage() {
  const { t } = useTranslation('rss');
  const [tab, setTab] = useState('score');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('scoring.page.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('scoring.page.subtitle')}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto scrollbar-thin">
          <TabsList>
            <TabsTrigger value="score">{t('scoring.tabs.score')}</TabsTrigger>
            <TabsTrigger value="rule">{t('scoring.tabs.rule')}</TabsTrigger>
          </TabsList>
        </div>
        <div className="mt-4">
          <TabsContent value="score">
            <ScoringPanel mode="score" />
          </TabsContent>
          <TabsContent value="rule">
            <ScoringPanel mode="rule" />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function ScoringPanel({ mode }: { mode: 'score' | 'rule' }) {
  const { t } = useTranslation('rss');
  const toast = useToast();
  const [form, setForm] = useState<ScoringForm>(EMPTY_FORM);
  const [result, setResult] = useState<ReleaseScoreResult | ReleaseTestRuleResult | null>(null);

  const trackerHealthOptions = TRACKER_HEALTH_VALUES.map((value) => ({
    value,
    label: t(`scoring.trackerHealth.${TRACKER_HEALTH_KEYS[value]}` as 'scoring.trackerHealth.unspecified'),
  }));

  const buildPreferences = (): Omit<ReleaseScoreInput, 'title'> => ({
    preferredResolution: form.preferredResolution.trim() || undefined,
    preferredCodec: form.preferredCodec.trim() || undefined,
    preferredSources: form.preferredSources.length ? form.preferredSources : undefined,
    preferredGroups: form.preferredGroups.length ? form.preferredGroups : undefined,
    avoidedGroups: form.avoidedGroups.length ? form.avoidedGroups : undefined,
    excludedTerms: form.excludedTerms.length ? form.excludedTerms : undefined,
    seeders: form.seeders.trim() ? Number(form.seeders.trim()) : undefined,
    trackerHealth: (form.trackerHealth || undefined) as TrackerHealth | undefined,
    duplicateRisk: form.duplicateRisk || undefined,
  });

  const mutation = useMutation({
    mutationFn: () => {
      if (mode === 'score') {
        return api.releaseScoring.score({ title: form.title.trim(), ...buildPreferences() });
      }
      const minScore = Number(form.minScore.trim());
      return api.releaseScoring.testRule({
        title: form.title.trim(),
        rule: {
          ...buildPreferences(),
          minScore: Number.isFinite(minScore) ? minScore : undefined,
        },
      });
    },
    onSuccess: (res) => setResult(res),
    onError: (err) =>
      toast.error(t('scoring.toast.scoringFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error(t('scoring.toast.titleRequired'), t('scoring.toast.titleRequiredBody'));
      return;
    }
    mutation.mutate();
  };

  const ruleResult = mode === 'rule' ? (result as ReleaseTestRuleResult | null) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardContent className="p-5">
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="rs-title">{t('scoring.form.title')}</Label>
              <Input
                id="rs-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder={t('scoring.form.titlePlaceholder')}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rs-res">{t('scoring.form.preferredResolution')}</Label>
                <Input
                  id="rs-res"
                  value={form.preferredResolution}
                  onChange={(e) => setForm((f) => ({ ...f, preferredResolution: e.target.value }))}
                  placeholder={t('scoring.form.preferredResolutionPlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rs-codec">{t('scoring.form.preferredCodec')}</Label>
                <Input
                  id="rs-codec"
                  value={form.preferredCodec}
                  onChange={(e) => setForm((f) => ({ ...f, preferredCodec: e.target.value }))}
                  placeholder={t('scoring.form.preferredCodecPlaceholder')}
                />
              </div>
            </div>

            <ChipInput
              label={t('scoring.form.preferredSources')}
              placeholder={t('scoring.form.preferredSourcesPlaceholder')}
              values={form.preferredSources}
              onChange={(values) => setForm((f) => ({ ...f, preferredSources: values }))}
            />
            <ChipInput
              label={t('scoring.form.preferredGroups')}
              placeholder={t('scoring.form.preferredGroupsPlaceholder')}
              values={form.preferredGroups}
              onChange={(values) => setForm((f) => ({ ...f, preferredGroups: values }))}
            />
            <ChipInput
              label={t('scoring.form.avoidedGroups')}
              placeholder={t('scoring.form.avoidedGroupsPlaceholder')}
              values={form.avoidedGroups}
              onChange={(values) => setForm((f) => ({ ...f, avoidedGroups: values }))}
            />
            <ChipInput
              label={t('scoring.form.excludedTerms')}
              placeholder={t('scoring.form.excludedTermsPlaceholder')}
              values={form.excludedTerms}
              onChange={(values) => setForm((f) => ({ ...f, excludedTerms: values }))}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rs-seeders">{t('scoring.form.seeders')}</Label>
                <Input
                  id="rs-seeders"
                  type="number"
                  value={form.seeders}
                  onChange={(e) => setForm((f) => ({ ...f, seeders: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rs-tracker">{t('scoring.form.trackerHealthLabel')}</Label>
                <Select
                  id="rs-tracker"
                  value={form.trackerHealth}
                  onChange={(e) => setForm((f) => ({ ...f, trackerHealth: e.target.value }))}
                  options={trackerHealthOptions}
                />
              </div>
            </div>

            {mode === 'rule' && (
              <div className="space-y-1.5">
                <Label htmlFor="rs-min">{t('scoring.form.minScore')}</Label>
                <Input
                  id="rs-min"
                  type="number"
                  value={form.minScore}
                  onChange={(e) => setForm((f) => ({ ...f, minScore: e.target.value }))}
                />
              </div>
            )}

            <label className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={form.duplicateRisk}
                onChange={(e) => setForm((f) => ({ ...f, duplicateRisk: e.target.checked }))}
                className="h-4 w-4 rounded border-input bg-white/[0.02]"
              />
              {t('scoring.form.duplicateRisk')}
            </label>

            <Button type="submit" loading={mutation.isPending}>
              <Gauge className="h-4 w-4" />{' '}
              {mode === 'score' ? t('scoring.actions.scoreRelease') : t('scoring.actions.testRule')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="lg:col-span-2">
        {result ? (
          <ResultPanel result={result} ruleResult={ruleResult} />
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/5">
                <Award className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold">{t('scoring.result.emptyTitle')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('scoring.result.emptyBody', {
                    action:
                      mode === 'score'
                        ? t('scoring.result.emptyActionScore')
                        : t('scoring.result.emptyActionRule'),
                  })}
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function ResultPanel({
  result,
  ruleResult,
}: {
  result: ReleaseScoreResult | ReleaseTestRuleResult;
  ruleResult: ReleaseTestRuleResult | null;
}) {
  const { t } = useTranslation('rss');
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t('scoring.result.scoreLabel')}
            </p>
            <p className={cn('text-4xl font-bold tabular-nums', scoreTone(result.score))}>
              {Math.round(result.score)}
              <span className="text-lg text-muted-foreground">/100</span>
            </p>
          </div>
          <Badge variant={decisionVariant(result.decision)} className="px-3 py-1 text-sm capitalize">
            {result.decision}
          </Badge>
        </div>

        {ruleResult && (
          <div
            className={cn(
              'flex items-center justify-between rounded-md border px-3 py-2.5 text-sm',
              ruleResult.passed
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-destructive/30 bg-destructive/10 text-destructive',
            )}
          >
            <span className="font-medium">
              {ruleResult.passed ? t('scoring.result.passed') : t('scoring.result.failed')}
            </span>
            <span className="text-xs tabular-nums">
              {t('scoring.result.vsMin', {
                score: Math.round(ruleResult.score),
                min: ruleResult.minScore,
              })}
            </span>
          </div>
        )}

        {result.reasons.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('scoring.result.reasons')}
            </p>
            <ul className="space-y-1.5">
              {result.reasons.map((reason, i) => {
                const negative = /avoid|exclud|penal|missing|low|dead|reject|skip|duplicat/i.test(
                  reason,
                );
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {negative ? (
                      <ThumbsDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    ) : (
                      <ThumbsUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    )}
                    <span className={negative ? 'text-destructive' : 'text-foreground/90'}>
                      {reason}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {result.warnings.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('scoring.result.warnings')}
            </p>
            <ul className="space-y-1.5">
              {result.warnings.map((warning, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-warning">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChipInput({
  label,
  placeholder,
  values,
  onChange,
}: {
  label: string;
  placeholder?: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const { t } = useTranslation('rss');
  const [draft, setDraft] = useState('');

  const commit = () => {
    const next = draft.trim();
    if (next && !values.includes(next)) onChange([...values, next]);
    setDraft('');
  };

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-white/[0.04] px-2.5 py-0.5 text-xs"
          >
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((v) => v !== value))}
              aria-label={t('scoring.chip.remove', { value })}
              className="text-muted-foreground transition-colors hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder={placeholder}
      />
    </div>
  );
}
