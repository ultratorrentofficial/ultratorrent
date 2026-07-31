import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Undo2, ShuffleIcon } from 'lucide-react';
import { api, ApiError, type RuleMigrationPreview, type MigrationVerdict } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const TONE: Record<MigrationVerdict, 'success' | 'secondary' | 'warning'> = {
  convertible: 'success',
  already_managed: 'secondary',
  no_profile: 'warning',
  staging_conflict: 'warning',
};

/**
 * Bulk conversion of RSS rules to Managed Intake.
 *
 * Converting a rule is two coordinated edits — repoint its save path at staging
 * and set the mode — and the server refuses half of that pair, because a managed
 * rule still downloading into its destination library imports that library into
 * itself. Doing both by hand is a two-step dance per rule, and an install can
 * carry hundreds; this does the pair atomically for a chosen set.
 *
 * Nothing is preselected. The dangerous half of a migration is the one that
 * decides for you which rules were meant, so the operator picks and the screen
 * shows exactly what each choice will write.
 */
export function MigrationWizardPage() {
  const { t } = useTranslation('intake');
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const preview = useQuery({
    queryKey: ['intake', 'migration', 'preview'],
    queryFn: () => api.intake.migrationPreview(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['intake', 'migration'] });
    qc.invalidateQueries({ queryKey: ['rss'] });
    setSelected(new Set());
  };

  const apply = useMutation({
    mutationFn: (ids: string[]) => api.intake.applyMigration(ids),
    onSuccess: (r) => {
      toast.success(t('migrate.applied', { count: r.converted }));
      // Skipped rules are reported, never silently dropped — a count that does
      // not match the selection is exactly what erodes trust in a bulk action.
      if (r.skipped.length) toast.error(t('migrate.someSkipped', { count: r.skipped.length }));
      invalidate();
    },
    onError: (e) => toast.error(t('migrate.applyFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const revert = useMutation({
    mutationFn: (ids: string[]) => api.intake.revertMigration(ids),
    onSuccess: (r) => { toast.success(t('migrate.reverted', { count: r.reverted })); invalidate(); },
    onError: (e) => toast.error(t('migrate.revertFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const rows = preview.data ?? [];
  const convertible = useMemo(() => rows.filter((r) => r.verdict === 'convertible'), [rows]);
  const managed = useMemo(() => rows.filter((r) => r.verdict === 'already_managed'), [rows]);

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (preview.isLoading) return <div className="p-6"><CenteredSpinner label={t('migrate.loading')} /></div>;
  if (preview.isError) {
    return <div className="p-6"><ErrorState message={t('migrate.loadFailed')} onRetry={() => preview.refetch()} /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media/settings/intake')}>
          <ArrowLeft className="h-4 w-4" /> {t('migrate.back')}
        </Button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ShuffleIcon className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">{t('migrate.title')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('migrate.subtitle')}</p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<ShuffleIcon className="h-6 w-6" />}
          title={t('migrate.emptyTitle')}
          description={t('migrate.emptyBody')}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => apply.mutate([...selected])}
              disabled={selected.size === 0 || apply.isPending}
              loading={apply.isPending}
            >
              <ArrowRight className="h-4 w-4" /> {t('migrate.convertBtn', { count: selected.size })}
            </Button>
            <Button
              variant="outline"
              onClick={() => setSelected(new Set(convertible.map((r) => r.ruleId)))}
              disabled={convertible.length === 0}
            >
              {t('migrate.selectAll', { count: convertible.length })}
            </Button>
            {managed.length > 0 && (
              <Button
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  if (window.confirm(t('migrate.revertConfirm', { count: managed.length }))) {
                    revert.mutate(managed.map((r) => r.ruleId));
                  }
                }}
                loading={revert.isPending}
              >
                <Undo2 className="h-4 w-4" /> {t('migrate.revertAll', { count: managed.length })}
              </Button>
            )}
          </div>

          <div className="space-y-1.5">
            {rows.map((row) => (
              <RuleRow
                key={row.ruleId}
                row={row}
                checked={selected.has(row.ruleId)}
                onToggle={() => toggle(row.ruleId)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RuleRow({ row, checked, onToggle }: {
  row: RuleMigrationPreview; checked: boolean; onToggle: () => void;
}) {
  const { t } = useTranslation('intake');
  const selectable = row.verdict === 'convertible';

  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={checked}
          onChange={onToggle}
          disabled={!selectable}
          aria-label={t('migrate.selectAria', { name: row.name })}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{row.name}</span>
            <Badge variant={TONE[row.verdict]}>{t(`migrate.verdict.${row.verdict}` as never)}</Badge>
            {row.profileName && (
              <span className="text-xs text-muted-foreground">{row.profileName}</span>
            )}
          </div>
          {/* Both paths, always — the whole question is what this will rewrite. */}
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {row.currentSavePath ?? t('migrate.noPath')}
            {row.proposedSavePath && <> → <span className="text-foreground">{row.proposedSavePath}</span></>}
          </p>
          {row.reason && <p className="mt-0.5 text-xs text-warning">{row.reason}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
