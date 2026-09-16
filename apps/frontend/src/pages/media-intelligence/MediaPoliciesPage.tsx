import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  LIFECYCLE_COMPLETENESS_INTENTS,
  LIFECYCLE_POLICY_MODES,
  LIFECYCLE_QUALITY_INTENTS,
  LIFECYCLE_SCOPE_TYPES,
  PERMISSIONS,
  type LifecyclePolicyPreview,
  type MediaLifecyclePolicy,
} from '@ultratorrent/shared';

import { ApiError, api, type LifecyclePolicyInput } from '@/lib/api';
import { usePermission } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatNumber } from '@/lib/format';

/**
 * Lifecycle policies — what the operator wants maintained.
 *
 * Two things this page is careful about.
 *
 * **It never claims to act.** Every mode is advisory, and the editor says so
 * under the mode picker rather than leaving an operator to infer it from an
 * absent "automatic" option. A control that implies maintenance happens on
 * its own would be a lie the rest of the feature then has to live with.
 *
 * **It shows what cannot be known.** The subtitle field carries its caveat
 * inline, because the honest answer for a missing language is "no record of
 * it", not "it is absent" — and an operator configuring a requirement
 * deserves to know that before they rely on it.
 */
export function MediaPoliciesPage() {
  const { t } = useTranslation('mediaIntelligence');
  const canManage = usePermission(PERMISSIONS.MEDIA_LIFECYCLE_POLICY_MANAGE);
  const queryClient = useQueryClient();
  const toast = useToast();

  const policies = useQuery({
    queryKey: ['mediaIntelligence', 'policies'],
    queryFn: () => api.mediaIntelligence.policies(),
  });
  const [editing, setEditing] = useState<MediaLifecyclePolicy | 'new' | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.mediaIntelligence.deletePolicy(id),
    onSuccess: (r) => {
      // Removing intent changes conclusions, so the library is re-evaluated
      // in the background. Say so rather than letting the list look inert.
      if (r.reevaluationJobId) toast.success(t('policies.reevaluating'));
      void queryClient.invalidateQueries({ queryKey: ['mediaIntelligence'] });
    },
    onError: (e) =>
      toast.error(t('policies.deleteFailed'), e instanceof ApiError ? e.message : undefined),
  });

  if (policies.isLoading) return <CenteredSpinner label={t('policies.title')} />;
  if (policies.isError) {
    return (
      <ErrorState
        title={t('policies.title')}
        message={policies.error instanceof ApiError ? policies.error.message : undefined}
        onRetry={() => void policies.refetch()}
      />
    );
  }

  const rows = policies.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('policies.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('policies.subtitle')}</p>
        </div>
        {canManage ? (
          <Button onClick={() => setEditing('new')}>
            <Plus className="mr-1 h-4 w-4" />
            {t('policies.create')}
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="py-4">
          {rows.length === 0 ? (
            <EmptyState title={t('policies.empty')} description={t('policies.emptyHint')} />
          ) : (
            <div data-testid="policy-rows" className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('policies.columns.name')}</TableHead>
                    <TableHead>{t('policies.columns.scope')}</TableHead>
                    <TableHead>{t('policies.columns.maintains')}</TableHead>
                    <TableHead>{t('policies.columns.mode')}</TableHead>
                    <TableHead>{t('policies.columns.state')}</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        {t(`policies.scopeType.${p.scopeType}` as 'policies.scopeType.global')}
                      </TableCell>
                      <TableCell>
                        <Maintains policy={p} />
                      </TableCell>
                      <TableCell>
                        {t(`policies.modes.${p.mode}` as 'policies.modes.recommend_only')}
                      </TableCell>
                      <TableCell>
                        {/* A word, never colour alone. */}
                        <Badge variant={p.enabled ? 'success' : 'outline'} dot>
                          {p.enabled ? t('policies.enabled') : t('policies.disabled')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage ? (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                              {t('policies.edit')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={remove.isPending}
                              onClick={() => remove.mutate(p.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                              <span className="sr-only">{t('policies.delete')}</span>
                            </Button>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {editing ? (
        <PolicyEditor
          policy={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['mediaIntelligence'] });
          }}
        />
      ) : null}
    </div>
  );
}

/** The dimensions a policy actually speaks to. Silence is not a value. */
function Maintains({ policy }: { policy: MediaLifecyclePolicy }) {
  const { t } = useTranslation('mediaIntelligence');
  const parts: string[] = [];
  if (policy.quality) parts.push(t(`policies.quality.${policy.quality}` as 'policies.quality.do_not_manage'));
  if (policy.completeness) {
    parts.push(t(`policies.completeness.${policy.completeness}` as 'policies.completeness.do_not_manage'));
  }
  if (policy.subtitleLanguages?.length) parts.push(policy.subtitleLanguages.join(', '));
  return <span className="text-sm text-muted-foreground">{parts.join(' · ') || '—'}</span>;
}

/**
 * The editor.
 *
 * Typed fields only — no JSON reaches the operator. Every dimension has an
 * explicit "say nothing (inherit)" option, because the difference between
 * silence and an explicit decision is the whole inheritance contract and a
 * blank box cannot express it.
 */
function PolicyEditor({
  policy,
  onClose,
  onSaved,
}: {
  policy: MediaLifecyclePolicy | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('mediaIntelligence');
  const toast = useToast();

  const [name, setName] = useState(policy?.name ?? '');
  const [scopeType, setScopeType] = useState(policy?.scopeType ?? 'global');
  const [scopeId, setScopeId] = useState(policy?.scopeId ?? '');
  const [mode, setMode] = useState<string>(policy?.mode ?? 'recommend_only');
  const [quality, setQuality] = useState<string>(policy?.quality ?? '');
  const [completeness, setCompleteness] = useState<string>(policy?.completeness ?? '');
  const [subtitles, setSubtitles] = useState((policy?.subtitleLanguages ?? []).join(', '));
  const [preview, setPreview] = useState<LifecyclePolicyPreview | null>(null);

  // Only fetched for the scope that needs it; a global policy names nothing.
  const libraries = useQuery({
    queryKey: ['media', 'libraries'],
    queryFn: () => api.media.libraries(),
    enabled: scopeType === 'library',
  });

  const body = useMemo<LifecyclePolicyInput>(
    () => ({
      name: name.trim(),
      scopeType,
      scopeId: scopeType === 'global' ? null : scopeId.trim() || null,
      mode,
      // '' is the UI's "say nothing", which must reach the API as null so the
      // dimension inherits rather than being pinned.
      quality: quality || null,
      completeness: completeness || null,
      subtitleLanguages: subtitles.trim()
        ? subtitles.split(',').map((l) => l.trim()).filter(Boolean)
        : null,
    }),
    [name, scopeType, scopeId, mode, quality, completeness, subtitles],
  );

  const runPreview = useMutation({
    mutationFn: () => api.mediaIntelligence.previewPolicy({ ...body, id: policy?.id }),
    onSuccess: setPreview,
    onError: (e) =>
      toast.error(t('policies.previewFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const save = useMutation({
    mutationFn: () =>
      policy
        ? api.mediaIntelligence.updatePolicy(policy.id, body)
        : api.mediaIntelligence.createPolicy(body),
    onSuccess: (r) => {
      if (r.reevaluationJobId) toast.success(t('policies.reevaluating'));
      onSaved();
    },
    onError: (e) =>
      toast.error(t('policies.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Dialog open onClose={onClose} title={policy ? t('policies.edit') : t('policies.create')}>
      <DialogHeader>
        <DialogTitle>{policy ? policy.name : t('policies.create')}</DialogTitle>
        <DialogDescription>{t('policies.subtitle')}</DialogDescription>
      </DialogHeader>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-2">
        <div>
          <Label htmlFor="policy-name">{t('policies.name')}</Label>
          <Input
            id="policy-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('policies.namePlaceholder')}
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <div>
            <Label htmlFor="policy-scope">{t('policies.scope')}</Label>
            <Select
              id="policy-scope"
              className="mt-1 w-auto"
              value={scopeType}
              onChange={(e) => {
                setScopeType(e.target.value as typeof scopeType);
                // An id belongs to exactly one scope. Carrying a library id
                // over to `series` would leave the box looking filled while
                // naming nothing that scope can match.
                setScopeId('');
              }}
              options={LIFECYCLE_SCOPE_TYPES.map((s) => ({
                value: s,
                label: t(`policies.scopeType.${s}` as 'policies.scopeType.global'),
              }))}
            />
          </div>
          {scopeType !== 'global' ? (
            <div className="min-w-[16rem] flex-1">
              <Label htmlFor="policy-scope-id">{t('policies.scopeId')}</Label>
              {scopeType === 'library' ? (
                <Select
                  id="policy-scope-id"
                  className="mt-1"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                  options={[
                    { value: '', label: t('policies.scopePick') },
                    ...(libraries.data ?? []).map((l) => ({ value: l.id, label: l.name })),
                  ]}
                />
              ) : (
                <Input
                  id="policy-scope-id"
                  className="mt-1"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                />
              )}
            </div>
          ) : null}
        </div>

        <Dimension
          id="policy-quality"
          label={t('policies.quality.label')}
          help={t('policies.quality.help')}
          value={quality}
          onChange={setQuality}
          unsetLabel={t('policies.quality.unset')}
          options={LIFECYCLE_QUALITY_INTENTS.map((v) => ({
            value: v,
            label: t(`policies.quality.${v}` as 'policies.quality.do_not_manage'),
          }))}
        />

        <Dimension
          id="policy-completeness"
          label={t('policies.completeness.label')}
          help={t('policies.completeness.help')}
          value={completeness}
          onChange={setCompleteness}
          unsetLabel={t('policies.completeness.unset')}
          options={LIFECYCLE_COMPLETENESS_INTENTS.map((v) => ({
            value: v,
            label: t(`policies.completeness.${v}` as 'policies.completeness.do_not_manage'),
          }))}
        />

        <div>
          <Label htmlFor="policy-subtitles">{t('policies.subtitles.label')}</Label>
          <Input
            id="policy-subtitles"
            value={subtitles}
            onChange={(e) => setSubtitles(e.target.value)}
            placeholder={t('policies.subtitles.placeholder')}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('policies.subtitles.help')}</p>
          {/* Stated where the decision is made, not buried in documentation. */}
          <p className="mt-1 text-xs text-muted-foreground">{t('policies.subtitles.caveat')}</p>
        </div>

        <div>
          <Label htmlFor="policy-mode">{t('policies.mode')}</Label>
          <Select
            id="policy-mode"
            className="mt-1 w-auto"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={LIFECYCLE_POLICY_MODES.map((m) => ({
              value: m,
              label: t(`policies.modes.${m}` as 'policies.modes.recommend_only'),
            }))}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('policies.modeHelp')}</p>
        </div>

        {preview ? <PreviewPanel preview={preview} /> : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('policies.cancel')}
        </Button>
        <Button variant="outline" loading={runPreview.isPending} onClick={() => runPreview.mutate()}>
          {t('policies.preview')}
        </Button>
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          {t('policies.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** One dimension, with an explicit "say nothing" that is not the same as off. */
function Dimension({
  id,
  label,
  help,
  value,
  onChange,
  unsetLabel,
  options,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  onChange: (v: string) => void;
  unsetLabel: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        className="mt-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={[{ value: '', label: unsetLabel }, ...options]}
      />
      <p className="mt-1 text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

/**
 * What the policy would do, computed by the production evaluator.
 *
 * Labelled a simulation, and honest about being a sample: a global scope
 * covers thousands of titles, so the preview evaluates a bounded slice and
 * says which.
 */
function PreviewPanel({ preview }: { preview: LifecyclePolicyPreview }) {
  const { t } = useTranslation('mediaIntelligence');

  return (
    <div data-testid="policy-preview" className="space-y-2 rounded-md border border-border p-3">
      <div className="text-sm font-medium">{t('policies.previewTitle')}</div>
      <p className="text-xs text-muted-foreground">{t('policies.previewIntro')}</p>

      {preview.evaluated === 0 ? (
        <p className="text-sm text-muted-foreground">{t('policies.previewEmpty')}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 text-sm">
            <span>{t('policies.previewEvaluated', { count: preview.evaluated })}</span>
            <Badge variant="success" dot>
              {t('policies.status.compliant')}: {formatNumber(preview.compliant)}
            </Badge>
            <Badge variant="warning" dot>
              {t('policies.status.drift')}: {formatNumber(preview.drift)}
            </Badge>
            <Badge variant="outline" dot>
              {t('policies.status.unknown')}: {formatNumber(preview.unknown)}
            </Badge>
          </div>

          {preview.truncated ? (
            <p className="text-xs text-muted-foreground">
              {t('policies.previewTruncated', { count: preview.evaluated })}
            </p>
          ) : null}

          {preview.samples.length ? (
            <div className="text-xs text-muted-foreground">
              <div className="font-medium">{t('policies.samples')}</div>
              <ul className="ml-4 list-disc">
                {preview.samples.slice(0, 5).map((s) => (
                  <li key={`${s.entityType}:${s.entityId}`}>
                    {s.title} — {s.dimensions.join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
