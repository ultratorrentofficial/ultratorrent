import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, type Connection, type Edge as FlowEdge, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, Send, Power, PowerOff } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { WorkflowCanvasNode } from './WorkflowCanvasNode';
import { NodePalette } from './NodePalette';
import { NodeConfigPanel } from './NodeConfigPanel';
import { ValidationPanel } from './ValidationPanel';
import { toFlow, fromFlow, newNodeId, type WorkflowFlowNode } from './graph-mapping';
import type { NodeDefinition, WorkflowGraph, WorkflowGraphNode, WorkflowValidationResult } from './types';

const nodeTypes: NodeTypes = { workflowNode: WorkflowCanvasNode };
const EMPTY_GRAPH: WorkflowGraph = { schemaVersion: 1, nodes: [], edges: [] };

export function WorkflowEditorPage() {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner />
    </ReactFlowProvider>
  );
}

function WorkflowEditorInner() {
  const { id = '' } = useParams();
  const { t } = useTranslation('workflows');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const catalogQuery = useQuery({ queryKey: ['workflows', 'catalog'], queryFn: () => api.workflows.catalog(), staleTime: 5 * 60_000 });
  const detailQuery = useQuery({ queryKey: ['workflows', id], queryFn: () => api.workflows.get(id), enabled: !!id });

  const defsByType = useMemo(() => {
    const map = new Map<string, NodeDefinition>();
    for (const d of catalogQuery.data?.nodes ?? []) map.set(d.type, d);
    return map;
  }, [catalogQuery.data]);

  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);
  const loadedFor = useRef<string | null>(null);

  const workflow = detailQuery.data?.workflow;
  const readOnly = !hasPermission(PERMISSIONS.WORKFLOWS_EDIT) || workflow?.status === 'archived';
  const canPublish = hasPermission(PERMISSIONS.WORKFLOWS_PUBLISH);

  // Hydrate the canvas once per workflow load (draft preferred, else published, else empty).
  useEffect(() => {
    if (!detailQuery.data || !catalogQuery.data || loadedFor.current === id) return;
    const graph = detailQuery.data.draftVersion?.graph ?? detailQuery.data.publishedVersion?.graph ?? EMPTY_GRAPH;
    const flow = toFlow(graph, defsByType, new Map());
    setNodes(flow.nodes);
    setEdges(flow.edges);
    loadedFor.current = id;
  }, [detailQuery.data, catalogQuery.data, defsByType, id, setNodes, setEdges]);

  const currentGraph = useCallback(() => fromFlow(nodes, edges), [nodes, edges]);

  // Debounced live validation as the graph changes.
  useEffect(() => {
    if (!loadedFor.current || nodes.length === 0) { setValidation(null); return; }
    const handle = setTimeout(() => {
      api.workflows.validate(currentGraph()).then(setValidation).catch(() => undefined);
    }, 500);
    return () => clearTimeout(handle);
  }, [nodes, edges, currentGraph]);

  // Reflect issue counts onto node badges when validation changes.
  useEffect(() => {
    if (!validation) return;
    const counts = new Map<string, number>();
    for (const issue of [...validation.errors, ...validation.warnings]) {
      if (issue.nodeId) counts.set(issue.nodeId, (counts.get(issue.nodeId) ?? 0) + 1);
    }
    setNodes((ns) => ns.map((n) => (n.data.issues === (counts.get(n.id) ?? 0) ? n : { ...n, data: { ...n.data, issues: counts.get(n.id) ?? 0 } })));
  }, [validation, setNodes]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, id: `e_${c.source}_${c.sourceHandle ?? 'out'}_${c.target}_${Date.now()}` }, eds));
    setDirty(true);
  }, [setEdges]);

  const addNode = useCallback((def: NodeDefinition) => {
    setNodes((ns) => {
      const ids = new Set(ns.map((n) => n.id));
      const nodeId = newNodeId(def.type.split('.').pop() ?? 'node', ids);
      const domainNode: WorkflowGraphNode = { id: nodeId, type: def.type, position: { x: 120 + ns.length * 24, y: 80 + ns.length * 24 } };
      const flowNode: WorkflowFlowNode = { id: nodeId, type: 'workflowNode', position: domainNode.position, data: { node: domainNode, def, issues: 0 } };
      return [...ns, flowNode];
    });
    setDirty(true);
  }, [setNodes]);

  const updateNode = useCallback((updated: WorkflowGraphNode) => {
    setNodes((ns) => ns.map((n) => (n.id === updated.id ? { ...n, data: { ...n.data, node: updated } } : n)));
    setDirty(true);
  }, [setNodes]);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    if (selectedId === nodeId) setSelectedId(null);
    setDirty(true);
  }, [setNodes, setEdges, selectedId]);

  const saveMut = useMutation({
    mutationFn: () => api.workflows.saveDraft(id, currentGraph()),
    onSuccess: (res) => {
      setValidation(res.validation);
      setDirty(false);
      toast.success(t('toast.saved'));
      void qc.invalidateQueries({ queryKey: ['workflows', id] });
      loadedFor.current = id; // keep canvas as-is (already reflects saved state)
    },
    onError: () => toast.error(t('toast.error')),
  });

  const publishMut = useMutation({
    mutationFn: async () => {
      if (dirty) await api.workflows.saveDraft(id, currentGraph());
      return api.workflows.publish(id);
    },
    onSuccess: () => {
      setDirty(false);
      toast.success(t('toast.publishedOk'));
      void qc.invalidateQueries({ queryKey: ['workflows', id] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) {
        const body = err.body as { validation?: WorkflowValidationResult } | undefined;
        if (body?.validation) setValidation(body.validation);
        toast.error(t('toast.publishBlocked'));
      } else {
        toast.error(t('toast.error'));
      }
    },
  });

  const toggleMut = useMutation({
    mutationFn: (enable: boolean) => (enable ? api.workflows.enable(id) : api.workflows.disable(id)),
    onSuccess: (_res, enable) => {
      toast.success(enable ? t('toast.enabled') : t('toast.disabledOk'));
      void qc.invalidateQueries({ queryKey: ['workflows', id] });
    },
    onError: () => toast.error(t('toast.error')),
  });

  if (catalogQuery.isLoading || detailQuery.isLoading) return <CenteredSpinner label={t('title')} />;
  if (detailQuery.isError || !workflow) return <ErrorState title={t('toast.error')} onRetry={() => detailQuery.refetch()} />;

  const selectedNode = nodes.find((n) => n.id === selectedId)?.data.node ?? null;
  const selectedDef = selectedNode ? defsByType.get(selectedNode.type) : undefined;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Link to="/workflows" className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-white/5 hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />{t('editor.backToList')}
          </Link>
          <div className="font-medium">{workflow.name}</div>
          <Badge variant="secondary">{t(`status.${workflow.status}`)}</Badge>
          {workflow.enabled && <Badge variant="success" dot>{t('list.enabled')}</Badge>}
          {readOnly && <Badge variant="warning">{t('editor.readOnly')}</Badge>}
          {dirty && <span className="text-xs text-amber-500">{t('editor.unsaved')}</span>}
        </div>
        <div className="flex items-center gap-2">
          {!readOnly && (
            <Button size="sm" variant="outline" disabled={saveMut.isPending || !dirty} onClick={() => saveMut.mutate()}>
              <Save className="mr-1 h-4 w-4" />{saveMut.isPending ? t('editor.saving') : t('editor.save')}
            </Button>
          )}
          {canPublish && (
            <Button size="sm" disabled={publishMut.isPending} onClick={() => publishMut.mutate()}>
              <Send className="mr-1 h-4 w-4" />{t('editor.publish')}
            </Button>
          )}
          {canPublish && workflow.publishedVersionId && (
            workflow.enabled
              ? <Button size="sm" variant="outline" onClick={() => toggleMut.mutate(false)}><PowerOff className="mr-1 h-4 w-4" />{t('editor.disable')}</Button>
              : <Button size="sm" variant="outline" onClick={() => toggleMut.mutate(true)}><Power className="mr-1 h-4 w-4" />{t('editor.enable')}</Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <aside className="w-56 shrink-0 border-r">
          <NodePalette nodes={catalogQuery.data?.nodes ?? []} readOnly={readOnly} onAdd={addNode} />
        </aside>

        {/* Canvas */}
        <div className="relative min-w-0 flex-1">
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">
              {t('editor.canvasEmpty')}
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel[0]?.id ?? null)}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
            onNodesDelete={(deleted) => { deleted.forEach((d) => deleteNode(d.id)); }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {/* Right rail: config + validation + accessible list */}
        <aside className="flex w-72 shrink-0 flex-col border-l">
          <div className="border-b">
            <div className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('config.title')}</div>
            <NodeConfigPanel node={selectedNode} def={selectedDef} readOnly={readOnly} onChange={updateNode} onDelete={deleteNode} />
          </div>
          <div className="border-b">
            <div className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('validation.title')}</div>
            <ValidationPanel result={validation} onSelectNode={setSelectedId} />
          </div>
          <AccessibleGraphView nodes={nodes} edges={edges} />
        </aside>
      </div>
    </div>
  );
}

/** Non-visual representation of the graph for screen readers / keyboard users. */
function AccessibleGraphView({ nodes, edges }: { nodes: WorkflowFlowNode[]; edges: FlowEdge[] }) {
  const { t } = useTranslation('workflows');
  return (
    <details className="overflow-y-auto p-3 text-xs">
      <summary className="cursor-pointer font-semibold text-muted-foreground">{t('editor.accessibleView')}</summary>
      <p className="mb-2 mt-1 text-[10px] text-muted-foreground">{t('editor.accessibleViewHint')}</p>
      <div className="mb-1 font-medium">{t('editor.nodesHeading', { count: nodes.length })}</div>
      <ul className="mb-2 list-disc space-y-0.5 pl-4">
        {nodes.map((n) => <li key={n.id}>{n.data.node.label || n.data.def?.label || n.data.node.type}</li>)}
      </ul>
      <div className="mb-1 font-medium">{t('editor.edgesHeading', { count: edges.length })}</div>
      <ul className="list-disc space-y-0.5 pl-4">
        {edges.map((e) => <li key={e.id}>{e.source} → {e.target}{e.sourceHandle ? ` (${e.sourceHandle})` : ''}</li>)}
      </ul>
    </details>
  );
}
