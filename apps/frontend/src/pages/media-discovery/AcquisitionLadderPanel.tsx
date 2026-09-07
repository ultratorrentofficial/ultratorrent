import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Info, Layers, Plus, Save, Trash2 } from 'lucide-react';
import { api, type AcquisitionRuleTemplate, type AcquisitionRuleTemplateCandidate } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  MATCH_TYPES,
  PATTERN_MATCH_TYPES,
  QUALITY_FIELDS,
  QUALITY_SUGGESTIONS,
  cleanQuality,
  fromBytes,
  joinTerms,
  move,
  parseTerms,
  renumber,
  toBytes,
} from './ladder';

/**
 * Authoring a match preference profile — the ordered ladder of release
 * preferences a generated rule is built from.
 *
 * Until now these existed only through the API, which was tolerable while they
 * were optional and is not now that an auto-monitoring template requires one.
 *
 * Two things this editor deliberately does not offer:
 *
 * **A priority number.** Position is priority. A number field beside a
 * drag-ordered list is two sources of truth that can disagree, and the ladder is
 * renumbered from zero on save anyway.
 *
 * **HDR and audio fields.** The match engine reads `quality`, `source`, `codec`
 * and `resolution` and nothing else, so an HDR select would look configured and
 * silently do nothing — the worst kind of setting. Dolby Vision and Atmos belong
 * in required terms, and the hint below says so rather than leaving somebody to
 * discover it from a server error.
 */

type Draft = Omit<AcquisitionRuleTemplate, 'id' | 'version'> & { id?: string; version?: number };

/** Const tuples, so the `t()` lookups stay inside i18next's typed key set. */
const MEDIA_TYPES = ['any', 'tv', 'movie', 'anime'] as const;
const UPGRADE_POLICIES = ['inherit', 'never', 'always'] as const;

const emptyCandidate = (): AcquisitionRuleTemplateCandidate => ({
  id: '',
  priorityOrder: 0,
  name: '',
  enabled: true,
  matchType: 'smart_episode_match',
  pattern: null,
  requiredTerms: [],
  excludedTerms: [],
  qualityRules: {},
  sizeRules: {},
});

const emptyDraft = (): Draft => ({
  name: '',
  description: null,
  mediaType: 'any',
  enabled: true,
  upgradePolicy: 'inherit',
  requiredTerms: [],
  excludedTerms: [],
  candidates: [emptyCandidate()],
});

function Rung({
  candidate,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  candidate: AcquisitionRuleTemplateCandidate;
  index: number;
  total: number;
  onChange: (next: AcquisitionRuleTemplateCandidate) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('mediaDiscovery');
  const set = <K extends keyof AcquisitionRuleTemplateCandidate>(
    key: K,
    value: AcquisitionRuleTemplateCandidate[K],
  ) => onChange({ ...candidate, [key]: value });

  return (
    <div className="space-y-3 rounded-lg border border-white/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {t('ladder.rung', { n: index + 1 })}
        </span>
        <Input
          className="max-w-56"
          value={candidate.name}
          placeholder={t('ladder.rungNamePlaceholder')}
          onChange={(e) => set('name', e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-xs">
          <Checkbox checked={candidate.enabled} onCheckedChange={(v) => set('enabled', Boolean(v))} />
          {t('ladder.enabled')}
        </label>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0}
            aria-label={t('ladder.moveUp')} onClick={() => onMove(index - 1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === total - 1}
            aria-label={t('ladder.moveDown')} onClick={() => onMove(index + 1)}>
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
            aria-label={t('ladder.removeRung')} onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-4">
        {QUALITY_FIELDS.map((field) => (
          <div key={field}>
            <Label className="text-xs">{t(`ladder.quality.${field}`)}</Label>
            <Input
              list={`quality-${field}`}
              value={candidate.qualityRules[field] ?? ''}
              placeholder={t('ladder.any')}
              onChange={(e) => set('qualityRules', { ...candidate.qualityRules, [field]: e.target.value })}
            />
            <datalist id={`quality-${field}`}>
              {QUALITY_SUGGESTIONS[field].map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </div>
        ))}
      </div>

      <div className="grid gap-2 md:grid-cols-4">
        <div>
          <Label className="text-xs">{t('ladder.matchType')}</Label>
          <Select value={candidate.matchType} onChange={(e) => set('matchType', e.target.value)}>
            {MATCH_TYPES.map((m) => (
              <option key={m} value={m}>
                {t(`ladder.match.${m}`)}
              </option>
            ))}
          </Select>
        </div>
        {PATTERN_MATCH_TYPES.has(candidate.matchType) && (
          <div className="md:col-span-3">
            <Label className="text-xs">{t('ladder.pattern')}</Label>
            <Input value={candidate.pattern ?? ''} onChange={(e) => set('pattern', e.target.value || null)} />
          </div>
        )}
      </div>

      <div className="grid gap-2 md:grid-cols-4">
        <div>
          {/* Gigabytes, because nobody types 8589934592. */}
          <Label className="text-xs">{t('ladder.minSize')}</Label>
          <Input
            type="number" min={0} step="0.1"
            value={fromBytes(candidate.sizeRules.minBytes)}
            placeholder={t('ladder.noLimit')}
            onChange={(e) => set('sizeRules', { ...candidate.sizeRules, minBytes: toBytes(e.target.value) as number })}
          />
        </div>
        <div>
          <Label className="text-xs">{t('ladder.maxSize')}</Label>
          <Input
            type="number" min={0} step="0.1"
            value={fromBytes(candidate.sizeRules.maxBytes)}
            placeholder={t('ladder.noLimit')}
            onChange={(e) => set('sizeRules', { ...candidate.sizeRules, maxBytes: toBytes(e.target.value) as number })}
          />
        </div>
        <div>
          <Label className="text-xs">{t('ladder.requiredTerms')}</Label>
          <Input value={joinTerms(candidate.requiredTerms)} placeholder="DV, Atmos"
            onChange={(e) => set('requiredTerms', parseTerms(e.target.value))} />
        </div>
        <div>
          <Label className="text-xs">{t('ladder.excludedTerms')}</Label>
          <Input value={joinTerms(candidate.excludedTerms)}
            onChange={(e) => set('excludedTerms', parseTerms(e.target.value))} />
        </div>
      </div>
    </div>
  );
}

function Editor({ initial, onDone }: { initial: Draft; onDone: () => void }) {
  const { t } = useTranslation('mediaDiscovery');
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(initial);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        description: draft.description,
        mediaType: draft.mediaType,
        enabled: draft.enabled,
        upgradePolicy: draft.upgradePolicy,
        requiredTerms: draft.requiredTerms,
        excludedTerms: draft.excludedTerms,
        candidates: renumber(draft.candidates).map((c) => ({
          priorityOrder: c.priorityOrder,
          name: c.name.trim(),
          enabled: c.enabled,
          matchType: c.matchType,
          pattern: PATTERN_MATCH_TYPES.has(c.matchType) ? c.pattern : null,
          requiredTerms: c.requiredTerms,
          excludedTerms: c.excludedTerms,
          // Cleared fields are dropped rather than sent as empty constraints.
          qualityRules: cleanQuality(c.qualityRules),
          sizeRules: Object.fromEntries(
            Object.entries(c.sizeRules).filter(([, v]) => typeof v === 'number' && v > 0),
          ),
        })),
      };
      return draft.id
        ? api.mediaDiscovery.updateAcquisitionTemplate(draft.id, body)
        : api.mediaDiscovery.createAcquisitionTemplate(body);
    },
    onSuccess: () => {
      toast.success(t('ladder.saved'));
      qc.invalidateQueries({ queryKey: ['discovery'] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setCandidate = (i: number, next: AcquisitionRuleTemplateCandidate) =>
    set('candidates', draft.candidates.map((c, n) => (n === i ? next : c)));

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <Label>{t('ladder.name')}</Label>
            <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="TV Premium 4K" />
          </div>
          <div>
            <Label>{t('ladder.mediaType')}</Label>
            <Select value={draft.mediaType} onChange={(e) => set('mediaType', e.target.value)}>
              {MEDIA_TYPES.map((m) => (
                <option key={m} value={m}>{t(`ladder.mediaTypes.${m}`)}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('ladder.upgradePolicy')}</Label>
            <Select value={draft.upgradePolicy ?? 'inherit'} onChange={(e) => set('upgradePolicy', e.target.value)}>
              {UPGRADE_POLICIES.map((u) => (
                <option key={u} value={u}>{t(`ladder.upgrade.${u}`)}</option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label>{t('ladder.templateRequired')}</Label>
            <Input value={joinTerms(draft.requiredTerms)} onChange={(e) => set('requiredTerms', parseTerms(e.target.value))} />
          </div>
          <div>
            <Label>{t('ladder.templateExcluded')}</Label>
            <Input value={joinTerms(draft.excludedTerms)} placeholder="CAM, TS, TC, SCR"
              onChange={(e) => set('excludedTerms', parseTerms(e.target.value))} />
          </div>
        </div>

        {/*
          * Said once, where it matters. These terms are a CONSTRAINT, not a
          * preference of the top rung — a fallback that dropped `CAM` would
          * accept exactly what the profile forbids.
          */}
        <p className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('ladder.termsHint')}
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('ladder.rungs')}
            </h4>
            <Button variant="secondary" size="sm"
              onClick={() => set('candidates', [...draft.candidates, emptyCandidate()])}>
              <Plus className="h-3.5 w-3.5" /> {t('ladder.addRung')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('ladder.orderHint')}</p>
          {draft.candidates.map((c, i) => (
            <Rung
              key={i}
              candidate={c}
              index={i}
              total={draft.candidates.length}
              onChange={(next) => setCandidate(i, next)}
              onMove={(to) => set('candidates', move(draft.candidates, i, to))}
              onRemove={() => set('candidates', draft.candidates.filter((_, n) => n !== i))}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onDone}>{t('ladder.cancel')}</Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !draft.name.trim() || !draft.candidates.some((c) => c.enabled && c.name.trim())}
          >
            <Save className="h-4 w-4" /> {t('ladder.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function AcquisitionLadderPanel() {
  const { t } = useTranslation('mediaDiscovery');
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);

  const list = useQuery({
    queryKey: ['discovery', 'acquisition-templates'],
    queryFn: () => api.mediaDiscovery.acquisitionTemplates(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.mediaDiscovery.deleteAcquisitionTemplate(id),
    onSuccess: () => {
      toast.success(t('ladder.deleted'));
      qc.invalidateQueries({ queryKey: ['discovery'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (editing) return <Editor initial={editing} onDone={() => setEditing(null)} />;
  if (list.isLoading) return <CenteredSpinner />;
  if (list.isError) return <ErrorState title={t('ladder.error')} />;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing(emptyDraft())}>
          <Plus className="h-4 w-4" /> {t('ladder.new')}
        </Button>
      </div>

      {!list.data?.length ? (
        <EmptyState
          icon={<Layers className="h-6 w-6" />}
          title={t('ladder.emptyTitle')}
          description={t('ladder.emptyDescription')}
        />
      ) : (
        list.data.map((tpl) => (
          <Card key={tpl.id}>
            <CardContent className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium">{tpl.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('ladder.summary', {
                      count: tpl.candidates.length,
                      mediaType: tpl.mediaType,
                      version: tpl.version,
                    })}
                  </span>
                  {!tpl.enabled && (
                    <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t('ladder.disabled')}
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {tpl.candidates
                    .filter((c) => c.enabled)
                    .map((c) => c.name)
                    .join('  →  ') || t('ladder.noEnabledRungs')}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setEditing(tpl)}>
                {t('ladder.edit')}
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive"
                aria-label={t('ladder.delete')} onClick={() => remove.mutate(tpl.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
