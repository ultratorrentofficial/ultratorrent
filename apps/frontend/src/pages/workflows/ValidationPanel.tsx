import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { WorkflowValidationResult } from './types';

interface Props {
  result: WorkflowValidationResult | null;
  onSelectNode: (nodeId: string) => void;
}

/** Live validation results — errors block publish, warnings are advisory. Clicking an
 *  issue that references a node selects it on the canvas. */
export function ValidationPanel({ result, onSelectNode }: Props) {
  const { t } = useTranslation('workflows');
  if (!result) return null;

  const { errors, warnings, valid } = result;

  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium">
        {valid ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-red-500" />}
        <span>{valid ? t('validation.valid') : t('validation.invalid', { count: errors.length })}</span>
      </div>

      {errors.length === 0 && warnings.length === 0 && (
        <p className="text-muted-foreground">{t('validation.noIssues')}</p>
      )}

      <ul className="space-y-1">
        {errors.map((issue, i) => (
          <li key={`e${i}`}>
            <button
              type="button"
              disabled={!issue.nodeId}
              onClick={() => issue.nodeId && onSelectNode(issue.nodeId)}
              className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent disabled:hover:bg-transparent"
            >
              <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
              <span>{issue.message}</span>
            </button>
          </li>
        ))}
        {warnings.map((issue, i) => (
          <li key={`w${i}`}>
            <button
              type="button"
              disabled={!issue.nodeId}
              onClick={() => issue.nodeId && onSelectNode(issue.nodeId)}
              className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent disabled:hover:bg-transparent"
            >
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
              <span>{issue.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
