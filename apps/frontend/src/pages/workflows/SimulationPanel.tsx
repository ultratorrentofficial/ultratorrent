import { useTranslation } from 'react-i18next';
import { CircleDot, AlertTriangle } from 'lucide-react';
import type { SimulationResult } from './types';

interface Props {
  result: SimulationResult | null;
  onSelectNode: (nodeId: string) => void;
}

const OUTCOME_COLOR: Record<string, string> = {
  executed: 'text-sky-500',
  evaluated: 'text-amber-500',
  waited: 'text-violet-500',
  requested_approval: 'text-rose-500',
  variable_set: 'text-slate-400',
  subworkflow: 'text-cyan-500',
  ended: 'text-emerald-500',
  skipped: 'text-muted-foreground',
  unreachable: 'text-muted-foreground',
};

/** The dry-run trace — ordered steps, each node's decision, and the actions that would run. */
export function SimulationPanel({ result, onSelectNode }: Props) {
  const { t } = useTranslation('workflows');
  if (!result) return <p className="p-3 text-xs text-muted-foreground">{t('simulate.empty')}</p>;

  return (
    <div className="space-y-2 p-3 text-xs">
      <p className="text-[10px] text-muted-foreground">{t('simulate.hint')}</p>
      <div className="font-medium text-emerald-500">
        {t('simulate.wouldExecute', { count: result.wouldExecute.length })}
      </div>
      {result.truncated && <div className="text-amber-500">{t('simulate.truncated')}</div>}

      <div className="mt-1 font-semibold uppercase tracking-wide text-muted-foreground">{t('simulate.steps')}</div>
      <ol className="space-y-1">
        {result.steps.map((step, i) => (
          <li key={`${step.nodeId}-${i}`}>
            <button
              type="button"
              onClick={() => onSelectNode(step.nodeId)}
              className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent"
            >
              <CircleDot className={`mt-0.5 h-3 w-3 shrink-0 ${OUTCOME_COLOR[step.outcome] ?? 'text-muted-foreground'}`} />
              <span className="min-w-0">
                <span className="font-mono">{step.nodeId}</span>
                <span className="text-muted-foreground"> · {step.outcome}</span>
                {step.detail && <span className="block truncate text-[10px] text-muted-foreground">{step.detail}</span>}
                {step.warnings?.map((w, wi) => (
                  <span key={wi} className="mt-0.5 flex items-start gap-1 text-[10px] text-amber-500">
                    <AlertTriangle className="mt-px h-2.5 w-2.5 shrink-0" />{w}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
