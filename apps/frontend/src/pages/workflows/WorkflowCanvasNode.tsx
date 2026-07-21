import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle } from 'lucide-react';
import type { WorkflowFlowNode } from './graph-mapping';
import type { NodeCategory } from './types';

/** Per-category accent — matches the palette so nodes read at a glance. */
const CATEGORY_ACCENT: Record<NodeCategory, string> = {
  trigger: 'border-emerald-500/60 bg-emerald-500/10',
  action: 'border-sky-500/60 bg-sky-500/10',
  condition: 'border-amber-500/60 bg-amber-500/10',
  branch: 'border-amber-500/60 bg-amber-500/10',
  delay: 'border-violet-500/60 bg-violet-500/10',
  wait: 'border-violet-500/60 bg-violet-500/10',
  parallel: 'border-indigo-500/60 bg-indigo-500/10',
  join: 'border-indigo-500/60 bg-indigo-500/10',
  transform: 'border-slate-500/60 bg-slate-500/10',
  variable: 'border-slate-500/60 bg-slate-500/10',
  approval: 'border-rose-500/60 bg-rose-500/10',
  subworkflow: 'border-cyan-500/60 bg-cyan-500/10',
  end: 'border-slate-600/60 bg-slate-600/10',
};

function WorkflowCanvasNodeInner({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const { node, def, issues } = data;
  const accent = def ? CATEGORY_ACCENT[def.category] : 'border-red-500/60 bg-red-500/10';
  const outputs = def?.ports.outputs ?? ['out'];
  const hasInput = (def?.ports.inputs ?? 1) !== 0;
  const title = node.label || def?.label || node.type;

  return (
    <div
      className={`relative min-w-[168px] max-w-[240px] rounded-md border px-3 py-2 text-xs shadow-sm ${accent} ${selected ? 'ring-2 ring-primary' : ''}`}
      role="group"
      aria-label={title}
    >
      {hasInput && <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5" />}

      <div className="flex items-start justify-between gap-2">
        <div className="font-medium leading-tight">{title}</div>
        {issues > 0 && (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" aria-label={`${issues} issue(s)`} />
        )}
      </div>
      <div className="mt-0.5 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {def?.category ?? 'unknown'}
        {def?.destructive ? ' · destructive' : ''}
      </div>

      {/* Output handles, one per named port, vertically distributed. */}
      {outputs.map((port, i) => (
        <Handle
          key={port}
          id={port}
          type="source"
          position={Position.Right}
          className="!h-2.5 !w-2.5"
          style={{ top: outputs.length === 1 ? '50%' : `${((i + 1) / (outputs.length + 1)) * 100}%` }}
        >
          {outputs.length > 1 && (
            <span className="pointer-events-none absolute right-3 -translate-y-1/2 whitespace-nowrap text-[9px] text-muted-foreground">
              {port}
            </span>
          )}
        </Handle>
      ))}
    </div>
  );
}

export const WorkflowCanvasNode = memo(WorkflowCanvasNodeInner);
