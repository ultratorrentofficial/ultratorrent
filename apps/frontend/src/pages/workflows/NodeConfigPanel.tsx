import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { NodeDefinition, WorkflowGraphNode } from './types';

interface Props {
  node: WorkflowGraphNode | null;
  def: NodeDefinition | undefined;
  readOnly: boolean;
  onChange: (node: WorkflowGraphNode) => void;
  onDelete: (id: string) => void;
}

/**
 * Settings for the selected node. Required config keys (from the registry) are always shown;
 * additional free-form keys can be added. Destructive nodes surface the mandatory
 * `acknowledgeDestructive` safeguard; delay/wait/approval nodes surface their time bounds.
 */
export function NodeConfigPanel({ node, def, readOnly, onChange, onDelete }: Props) {
  const { t } = useTranslation('workflows');
  const [newKey, setNewKey] = useState('');

  if (!node) {
    return <p className="p-4 text-sm text-muted-foreground">{t('config.none')}</p>;
  }

  const config = node.config ?? {};
  const required = new Set(def?.requiredConfig ?? []);
  const shownKeys = Array.from(new Set([...required, ...Object.keys(config)]))
    .filter((k) => k !== 'acknowledgeDestructive');

  const patchConfig = (key: string, value: unknown) => {
    onChange({ ...node, config: { ...config, [key]: value } });
  };
  const removeConfig = (key: string) => {
    const next = { ...config };
    delete next[key];
    onChange({ ...node, config: next });
  };

  return (
    <div className="space-y-4 p-4 text-sm">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('config.nodeType')}</div>
        <div className="font-mono text-xs">{node.type}</div>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t('config.label')}</span>
        <Input
          value={node.label ?? ''}
          disabled={readOnly}
          placeholder={def?.label ?? t('config.labelPlaceholder')}
          onChange={(e) => onChange({ ...node, label: e.target.value })}
        />
      </label>

      {def?.destructive && (
        <label className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-2">
          <Checkbox
            checked={config.acknowledgeDestructive === true}
            disabled={readOnly}
            onCheckedChange={(v) => patchConfig('acknowledgeDestructive', v === true)}
          />
          <span className="text-xs">{t('config.acknowledgeDestructive')}</span>
        </label>
      )}

      {def?.category === 'delay' && (
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">{t('config.duration')}</span>
          <Input
            type="number"
            min={1}
            value={String(config.duration ?? '')}
            disabled={readOnly}
            onChange={(e) => patchConfig('duration', Number(e.target.value))}
          />
        </label>
      )}

      {(def?.category === 'wait' || def?.category === 'approval') && (
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">{t('config.timeoutSeconds')}</span>
          <Input
            type="number"
            min={1}
            value={String(config.timeoutSeconds ?? '')}
            disabled={readOnly}
            onChange={(e) => patchConfig('timeoutSeconds', Number(e.target.value))}
          />
        </label>
      )}

      <div className="space-y-2">
        {shownKeys.map((key) => (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {key}{required.has(key) && <span className="ml-1 text-red-500">*</span>}
              </span>
              {!required.has(key) && !readOnly && (
                <button type="button" onClick={() => removeConfig(key)} aria-label={t('config.remove')}>
                  <Trash2 className="h-3 w-3 text-muted-foreground hover:text-red-500" />
                </button>
              )}
            </div>
            <Input
              value={stringifyValue(config[key])}
              disabled={readOnly}
              onChange={(e) => patchConfig(key, e.target.value)}
            />
          </div>
        ))}
      </div>

      {!readOnly && (
        <div className="flex gap-2">
          <Input
            value={newKey}
            placeholder={t('config.key')}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newKey.trim()) { patchConfig(newKey.trim(), ''); setNewKey(''); }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!newKey.trim()}
            onClick={() => { patchConfig(newKey.trim(), ''); setNewKey(''); }}
          >
            <Plus className="h-4 w-4" /> {t('config.addField')}
          </Button>
        </div>
      )}

      {!readOnly && (
        <Button type="button" variant="destructive" size="sm" className="w-full" onClick={() => onDelete(node.id)}>
          <Trash2 className="mr-1 h-4 w-4" /> {t('editor.deleteNode')}
        </Button>
      )}
    </div>
  );
}

function stringifyValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
