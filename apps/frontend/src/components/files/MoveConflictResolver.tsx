import { useTranslation } from 'react-i18next';
import { ArrowRight, CircleCheck, FileStack, Files, Info, Trash2 } from 'lucide-react';
import type { ConflictResolution, MoveConflict, MoveConflictReport } from '@/lib/api';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { formatBytes, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The decision step for a move/copy that collides with existing files.
 *
 * Presentational: it renders one card per conflict and reports the operator's
 * choice up via `onChange`. All analysis (what kind of conflict, which release is
 * better, what's recommended) is done on the backend and arrives in `report`; this
 * only lays the evidence out and captures the answer. The parent owns execution.
 */

const KIND_BADGE: Record<MoveConflict['kind'], BadgeVariant> = {
  identical: 'secondary',
  same_episode: 'warning',
  name_clash: 'outline',
};

const RESOLUTION_ICON: Record<ConflictResolution, typeof ArrowRight> = {
  replace: ArrowRight,
  keep_both: Files,
  delete_source: Trash2,
  skip: CircleCheck,
};

export function MoveConflictResolver({
  report,
  choices,
  onChange,
}: {
  report: MoveConflictReport;
  /** source path → chosen resolution. */
  choices: Record<string, ConflictResolution>;
  onChange: (source: string, resolution: ConflictResolution) => void;
}) {
  const { t } = useTranslation('files');
  return (
    <div className="space-y-3">
      {report.clean.length > 0 && (
        <p className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          {t('conflicts.cleanNote', { count: report.clean.length })}
        </p>
      )}
      {report.conflicts.map((c) => (
        <ConflictCard key={c.source.path} conflict={c} choice={choices[c.source.path]} onChange={onChange} />
      ))}
    </div>
  );
}

function ConflictCard({
  conflict,
  choice,
  onChange,
}: {
  conflict: MoveConflict;
  choice: ConflictResolution;
  onChange: (source: string, resolution: ConflictResolution) => void;
}) {
  const { t } = useTranslation('files');
  const { source, target, kind, verdict, verdictReasons } = conflict;
  const heading =
    source.show && source.season != null && source.episode != null
      ? `${source.show} · S${String(source.season).padStart(2, '0')}E${String(source.episode).padStart(2, '0')}`
      : source.name;

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{heading}</span>
        <Badge variant={KIND_BADGE[kind]}>{t(`conflicts.kind.${kind}`)}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <FileFacet title={t('conflicts.sourceLabel')} file={source} />
        <FileFacet title={t('conflicts.targetLabel')} file={target} highlight />
      </div>

      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <FileStack className="h-3.5 w-3.5 shrink-0" />
        {kind === 'identical'
          ? t('conflicts.verdict.identical')
          : verdict === 'source_better'
            ? t('conflicts.verdict.sourceBetter', { reasons: verdictReasons.join(', ') })
            : verdict === 'target_better'
              ? t('conflicts.verdict.targetBetter', { reasons: verdictReasons.join(', ') })
              : t('conflicts.verdict.equivalent')}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('conflicts.chooseAria')}>
        {conflict.allowed.map((res) => {
          const Icon = RESOLUTION_ICON[res];
          const active = choice === res;
          return (
            <button
              key={res}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(source.path, res)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border/60 text-muted-foreground hover:bg-muted/40',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(`conflicts.action.${res}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileFacet({
  title,
  file,
  highlight,
}: {
  title: string;
  file: MoveConflict['source'];
  highlight?: boolean;
}) {
  const { t } = useTranslation('files');
  const quality = [file.resolution, file.source, file.codec].filter(Boolean).join(' · ');
  const tags = [file.proper && 'PROPER', file.repack && 'REPACK'].filter(Boolean).join(' ');
  return (
    <div className={cn('rounded-lg p-2', highlight ? 'bg-warning/5' : 'bg-muted/30')}>
      <p className="mb-1 font-medium text-muted-foreground">{title}</p>
      <p className="truncate" title={file.name}>{file.name}</p>
      <dl className="mt-1 space-y-0.5 text-muted-foreground">
        <FacetRow label={t('conflicts.facet.size')} value={formatBytes(file.size)} />
        {quality && <FacetRow label={t('conflicts.facet.quality')} value={quality} />}
        {file.releaseGroup && <FacetRow label={t('conflicts.facet.group')} value={file.releaseGroup} />}
        {tags && <FacetRow label={t('conflicts.facet.tags')} value={tags} />}
        <FacetRow label={t('conflicts.facet.modified')} value={formatDateTime(file.modifiedAt)} />
      </dl>
    </div>
  );
}

function FacetRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="truncate text-right text-foreground/80" title={value}>{value}</dd>
    </div>
  );
}
