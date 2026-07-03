import {
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownRight,
  GripVertical,
  Pencil,
  Regex,
  Trash2,
} from 'lucide-react';
import type { RssRuleMatchCandidate } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Chip, matchTypeLabel } from './shared';

export interface CandidateCardProps {
  candidate: RssRuleMatchCandidate;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onConvertToRegex: () => void;
  onAddFallback: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}

export function CandidateCard({
  candidate,
  index,
  isFirst,
  isLast,
  isDragging,
  isDragOver,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleEnabled,
  onConvertToRegex,
  onAddFallback,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}: CandidateCardProps) {
  const canConvertToRegex =
    candidate.matchType !== 'regex' &&
    (candidate.matchType === 'contains_text' ||
      candidate.matchType === 'exact_text' ||
      candidate.matchType === 'wildcard') &&
    !!candidate.pattern;

  return (
    <Card
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={cn(
        'transition-all',
        !candidate.enabled && 'opacity-60',
        isDragging && 'opacity-40 ring-2 ring-primary',
        isDragOver && !isDragging && 'ring-2 ring-primary/60',
      )}
    >
      <CardContent className="flex gap-3 p-4">
        {/* Priority + drag handle + a11y reorder */}
        <div className="flex flex-col items-center gap-1">
          <span
            className="grid h-7 w-7 place-items-center rounded-md bg-white/[0.04] text-xs font-semibold tabular-nums"
            title="Priority"
          >
            {index + 1}
          </span>
          <span className="cursor-grab text-muted-foreground active:cursor-grabbing" aria-hidden>
            <GripVertical className="h-4 w-4" />
          </span>
          <div className="flex flex-col">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Move up"
              disabled={isFirst}
              onClick={onMoveUp}
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Move down"
              disabled={isLast}
              onClick={onMoveDown}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{candidate.name}</span>
            <Badge variant="secondary">{matchTypeLabel(candidate.matchType)}</Badge>
            {candidate.enabled ? (
              <Badge variant="success" dot>
                enabled
              </Badge>
            ) : (
              <Badge variant="secondary" dot>
                disabled
              </Badge>
            )}
          </div>

          {candidate.description && (
            <p className="mt-1 text-sm text-muted-foreground">{candidate.description}</p>
          )}

          {candidate.pattern && (
            <p className="mt-2 truncate font-mono text-xs text-foreground/80">
              <span className="text-muted-foreground">pattern:</span> {candidate.pattern}
            </p>
          )}

          {(candidate.requiredTerms.length > 0 || candidate.excludedTerms.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {candidate.requiredTerms.map((t) => (
                <Chip key={`req-${t}`} tone="success">
                  +{t}
                </Chip>
              ))}
              {candidate.excludedTerms.map((t) => (
                <Chip key={`exc-${t}`} tone="destructive">
                  −{t}
                </Chip>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {candidate.lastMatchedAt
                ? `last matched ${formatRelativeTime(candidate.lastMatchedAt)}`
                : 'never matched'}
            </span>
            <span>{candidate.matchCount} match{candidate.matchCount === 1 ? '' : 'es'}</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={onDuplicate}>
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </Button>
            <Button variant="ghost" size="sm" onClick={onAddFallback}>
              <CornerDownRight className="h-3.5 w-3.5" /> Add fallback
            </Button>
            {canConvertToRegex && (
              <Button variant="ghost" size="sm" onClick={onConvertToRegex}>
                <Regex className="h-3.5 w-3.5" /> Convert to regex
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">enabled</span>
              <Switch
                checked={candidate.enabled}
                onCheckedChange={onToggleEnabled}
                aria-label="Toggle candidate"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
