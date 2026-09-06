import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Eye, Play, Save } from 'lucide-react';
import {
  api,
  type DiscoveryPreview,
  type DiscoveryTemplate,
  type DiscoveryTemplateInput,
} from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { CategoryPolicyEditor, type CategoryPolicy } from './CategoryPolicyEditor';

/**
 * Creating and editing a discovery template.
 *
 * The form is arranged as the decision actually runs — what to look at, what to
 * do with it, where the result goes, how fast — so reading top to bottom
 * describes the pipeline rather than the schema.
 *
 * **Preview before enable is the point.** The engine can create watchlist
 * entries and RSS rules on its own, and the honest way to offer that is to show
 * exactly what would happen first. Preview posts the form as it stands, unsaved,
 * so the adjust-and-look-again loop costs nothing and persists nothing.
 */

const EMPTY: DiscoveryTemplateInput = {
  name: '',
  enabled: false,
  mediaType: 'any',
  upcomingWindowDays: 90,
  languages: [],
  regions: [],
  releaseTypes: [],
  autoMonitorCategories: [],
  notifyOnlyCategories: [],
  ignoreCategories: [],
  blockedFromAutoCategories: [],
  categoryMatchMode: 'ANY',
  minimumConfidence: 0.8,
  autoAddLimitPerDay: 10,
  autoAddLimitPerWeek: 30,
  createIntakeDirectory: false,
};

const MOVIE_RELEASE_TYPES = ['digital', 'streaming', 'wide_theatrical', 'limited_theatrical', 'physical', 'festival'];
const TV_RELEASE_TYPES = ['series_premiere', 'season_premiere', 'episode_air', 'finale'];

/** Comma-separated text ⇄ string[], so a list field stays a plain input. */
const toList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const fromList = (v?: string[] | null) => (v ?? []).join(', ');

export function TemplateForm({
  template,
  onSaved,
  onCancel,
}: {
  template?: DiscoveryTemplate;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('mediaDiscovery');
  const toast = useToast();
  const [form, setForm] = useState<DiscoveryTemplateInput>(() =>
    template ? { ...template } : { ...EMPTY },
  );
  const [preview, setPreview] = useState<DiscoveryPreview | null>(null);

  const options = useQuery({
    queryKey: ['discovery', 'template-options'],
    queryFn: () => api.mediaDiscovery.templateOptions(),
  });

  const set = <K extends keyof DiscoveryTemplateInput>(key: K, value: DiscoveryTemplateInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const runPreview = useMutation({
    mutationFn: () => api.mediaDiscovery.preview(form as Record<string, unknown>),
    onSuccess: setPreview,
    onError: (e: Error) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: (enable: boolean) => {
      const body = { ...form, enabled: enable };
      return template
        ? api.mediaDiscovery.updateTemplate(template.id, body)
        : api.mediaDiscovery.createTemplate(body);
    },
    onSuccess: () => {
      toast.success(t('templates.saved'));
      onSaved();
    },
    // The server refuses to enable a template that cannot do what it claims —
    // no feed, no storage profile — and its message names the missing piece.
    onError: (e: Error) => toast.error(e.message),
  });

  const releaseTypes = form.mediaType === 'movie'
    ? MOVIE_RELEASE_TYPES
    : form.mediaType === 'tv'
      ? TV_RELEASE_TYPES
      : [...MOVIE_RELEASE_TYPES, ...TV_RELEASE_TYPES];

  const canAutoMonitor = (form.autoMonitorCategories ?? []).length > 0;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label>{t('form.name')}</Label>
            <Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <Label>{t('form.mediaType')}</Label>
            <Select value={form.mediaType} onChange={(e) => set('mediaType', e.target.value)}>
              <option value="any">{t('form.anyType')}</option>
              <option value="tv">{t('filters.tv')}</option>
              <option value="movie">{t('filters.movies')}</option>
            </Select>
          </div>
        </div>

        {/* --- what to look at --- */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('form.sections.scope')}
          </h3>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Label>{t('form.windowDays')}</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={form.upcomingWindowDays ?? 90}
                onChange={(e) => set('upcomingWindowDays', Number(e.target.value))}
              />
            </div>
            <div>
              <Label>{t('form.languages')}</Label>
              <Input
                value={fromList(form.languages)}
                onChange={(e) => set('languages', toList(e.target.value))}
                placeholder="English"
              />
            </div>
            <div>
              <Label>{t('form.regions')}</Label>
              <Input
                value={fromList(form.regions)}
                onChange={(e) => set('regions', toList(e.target.value))}
                placeholder="US, PR"
              />
            </div>
          </div>

          <div>
            <Label>{t('form.releaseTypes')}</Label>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {releaseTypes.map((rt) => {
                const on = (form.releaseTypes ?? []).includes(rt);
                return (
                  <button
                    key={rt}
                    type="button"
                    onClick={() =>
                      set(
                        'releaseTypes',
                        on
                          ? (form.releaseTypes ?? []).filter((x) => x !== rt)
                          : [...(form.releaseTypes ?? []), rt],
                      )
                    }
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on
                        ? 'border-amber-400/50 bg-amber-400/15 text-amber-200'
                        : 'border-white/10 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t(`releaseTypes.${rt}` as never)}
                  </button>
                );
              })}
            </div>
            {/* An empty list means every type, which is not obvious from an empty row. */}
            {(form.releaseTypes ?? []).length === 0 && (
              <p className="pt-1 text-[11px] text-muted-foreground">{t('form.releaseTypesAll')}</p>
            )}
          </div>
        </section>

        {/* --- what to do with it --- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('form.sections.policy')}
          </h3>
          <CategoryPolicyEditor
            value={{
              autoMonitorCategories: form.autoMonitorCategories ?? [],
              notifyOnlyCategories: form.notifyOnlyCategories ?? [],
              ignoreCategories: form.ignoreCategories ?? [],
              blockedFromAutoCategories: form.blockedFromAutoCategories ?? [],
            }}
            onChange={(p: CategoryPolicy) => setForm((f) => ({ ...f, ...p }))}
          />
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <Label>{t('form.matchMode')}</Label>
              <Select
                value={form.categoryMatchMode}
                onChange={(e) => set('categoryMatchMode', e.target.value)}
              >
                <option value="ANY">{t('form.modeAny')}</option>
                <option value="ALL">{t('form.modeAll')}</option>
                <option value="PRIMARY">{t('form.modePrimary')}</option>
              </Select>
            </div>
            <div>
              <Label>{t('form.minPopularity')}</Label>
              <Input
                type="number"
                value={form.minimumPopularity ?? ''}
                onChange={(e) => set('minimumPopularity', e.target.value === '' ? null : Number(e.target.value))}
              />
            </div>
            <div>
              <Label>{t('form.minRating')}</Label>
              <Input
                type="number"
                step="0.1"
                value={form.minimumRating ?? ''}
                onChange={(e) => set('minimumRating', e.target.value === '' ? null : Number(e.target.value))}
              />
            </div>
            <div>
              <Label>{t('form.minConfidence')}</Label>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={form.minimumConfidence ?? 0.8}
                onChange={(e) => set('minimumConfidence', Number(e.target.value))}
              />
            </div>
          </div>
        </section>

        {/* --- where it goes --- */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('form.sections.destination')}
          </h3>
          {/*
            * Only shown when the template can actually auto-monitor. A
            * notify-only template generates nothing, so a feed and a profile are
            * not merely optional for it — they are irrelevant, and asking would
            * imply otherwise.
            */}
          {!canAutoMonitor ? (
            <p className="rounded bg-white/5 px-2 py-1.5 text-xs text-muted-foreground">
              {t('form.notifyOnlyNotice')}
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label>{t('form.feed')}</Label>
                <Select value={form.rssFeedId ?? ''} onChange={(e) => set('rssFeedId', e.target.value || null)}>
                  <option value="">{t('form.choose')}</option>
                  {(options.data?.feeds ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                      {!f.isEnabled ? ` — ${t('form.disabled')}` : ''}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t('form.storageProfile')}</Label>
                <Select
                  value={form.storageProfileId ?? ''}
                  onChange={(e) => set('storageProfileId', e.target.value || null)}
                >
                  <option value="">{t('form.choose')}</option>
                  {(options.data?.profiles ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t('form.acquisitionTemplate')}</Label>
                <Select
                  value={form.acquisitionTemplateId ?? ''}
                  onChange={(e) => set('acquisitionTemplateId', e.target.value || null)}
                >
                  <option value="">{t('form.acquisitionDefault')}</option>
                  {(options.data?.acquisitionTemplates ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} (v{a.version})
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t('form.pathTemplate')}</Label>
                <Input
                  value={form.pathTemplate ?? ''}
                  onChange={(e) => set('pathTemplate', e.target.value || null)}
                  placeholder="TV Shows/{tvshow} ({year})"
                />
                <p className="pt-1 text-[11px] text-muted-foreground">{t('form.pathHelp')}</p>
              </div>
            </div>
          )}
        </section>

        {/* --- how fast --- */}
        <section className="grid gap-3 md:grid-cols-2">
          <div>
            <Label>{t('form.perDay')}</Label>
            <Input
              type="number"
              min={0}
              value={form.autoAddLimitPerDay ?? 10}
              onChange={(e) => set('autoAddLimitPerDay', Number(e.target.value))}
            />
          </div>
          <div>
            <Label>{t('form.perWeek')}</Label>
            <Input
              type="number"
              min={0}
              value={form.autoAddLimitPerWeek ?? 30}
              onChange={(e) => set('autoAddLimitPerWeek', Number(e.target.value))}
            />
          </div>
        </section>

        {/* --- preview --- */}
        {preview && (
          <div className="space-y-2 rounded-md border border-white/10 bg-black/20 p-3">
            <p className="text-xs font-semibold">
              {t('preview.heading', { examined: preview.examined })}
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Stat label={t('preview.monitored')} value={preview.counts.auto_monitor ?? 0} tone="text-emerald-300" />
              <Stat label={t('preview.notified')} value={preview.counts.notify ?? 0} tone="text-sky-300" />
              <Stat label={t('preview.review')} value={preview.counts.needs_review ?? 0} tone="text-amber-300" />
              <Stat label={t('preview.ignored')} value={preview.counts.ignore ?? 0} tone="text-muted-foreground" />
            </div>
            {preview.limits.beyondWeeklyAllowance > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('preview.beyondAllowance', {
                  count: preview.limits.beyondWeeklyAllowance,
                  perWeek: preview.limits.perWeek,
                })}
              </p>
            )}
            {preview.truncated && (
              <p className="text-[11px] text-muted-foreground">{t('preview.truncated')}</p>
            )}
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {preview.samples
                .filter((s) => s.decision === 'auto_monitor')
                .slice(0, 6)
                .map((s) => (
                  <li key={s.discoveredMediaId}>
                    <span className="text-foreground">{s.title}</span>
                    {s.year ? ` (${s.year})` : ''} — {s.genres.slice(0, 3).join(', ')}
                  </li>
                ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
          <Button variant="secondary" onClick={() => runPreview.mutate()} disabled={runPreview.isPending}>
            <Eye className="h-3.5 w-3.5" />
            {t('actions.preview')}
          </Button>
          <Button variant="secondary" onClick={() => save.mutate(false)} disabled={save.isPending}>
            <Save className="h-3.5 w-3.5" />
            {t('actions.save')}
          </Button>
          {/*
            * Enabling is the consequential button and is deliberately last, after
            * Preview. The engine can create watchlist entries and rules on its
            * own; offering that before showing what it would do would be the
            * wrong order.
            */}
          <Button onClick={() => save.mutate(true)} disabled={save.isPending}>
            <Play className="h-3.5 w-3.5" />
            {t('actions.saveAndEnable')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded bg-white/5 px-2 py-1.5">
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
