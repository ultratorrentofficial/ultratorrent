import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ListFilter, Plus } from 'lucide-react';
import {
  ApiError,
  api,
  type RssRuleMatchCandidate,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { CandidateCard } from './rss-match/CandidateCard';
import { CandidateEditorDialog } from './rss-match/CandidateEditorDialog';
import { TestingPanel } from './rss-match/TestingPanel';
import { MatchHistoryPanel } from './rss-match/MatchHistoryPanel';
import { SmartMatchBuilder } from './rss-match/SmartMatchBuilder';

type EditorState =
  | { mode: 'create'; source: RssRuleMatchCandidate | null }
  | { mode: 'edit'; source: RssRuleMatchCandidate };

function reorderIds(ids: string[], fromId: string, toId: string): string[] {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}

export function RssRulePage() {
  const { ruleId = '' } = useParams<{ ruleId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState('preferences');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const feedsQuery = useQuery({ queryKey: ['rss'], queryFn: api.rss.list });
  const candidatesKey = ['rss', 'candidates', ruleId];
  const {
    data: candidates,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: candidatesKey,
    queryFn: () => api.rss.listCandidates(ruleId),
    enabled: !!ruleId,
  });

  const feeds = feedsQuery.data ?? [];
  const feed = feeds.find((f) => f.rules.some((r) => r.id === ruleId));
  const rule = feed?.rules.find((r) => r.id === ruleId);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: candidatesKey });

  const persistReorder = async (orderedIds: string[]) => {
    const previous = queryClient.getQueryData<RssRuleMatchCandidate[]>(candidatesKey);
    // Optimistic: reorder + renumber priorityOrder locally.
    if (previous) {
      const byId = new Map(previous.map((c) => [c.id, c]));
      const optimistic = orderedIds
        .map((id, idx) => {
          const c = byId.get(id);
          return c ? { ...c, priorityOrder: idx } : null;
        })
        .filter((c): c is RssRuleMatchCandidate => c != null);
      queryClient.setQueryData(candidatesKey, optimistic);
    }
    try {
      const updated = await api.rss.reorderCandidates(ruleId, orderedIds);
      queryClient.setQueryData(candidatesKey, updated);
    } catch (err) {
      if (previous) queryClient.setQueryData(candidatesKey, previous);
      toast.error('Could not reorder candidates', err instanceof ApiError ? err.message : undefined);
    }
  };

  const moveBy = (id: string, delta: number) => {
    if (!candidates) return;
    const ids = candidates.map((c) => c.id);
    const idx = ids.indexOf(id);
    const target = idx + delta;
    if (target < 0 || target >= ids.length) return;
    void persistReorder(reorderIds(ids, id, ids[target]));
  };

  const handleDrop = (targetId: string) => {
    if (!candidates || !dragId || dragId === targetId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = candidates.map((c) => c.id);
    void persistReorder(reorderIds(ids, dragId, targetId));
    setDragId(null);
    setOverId(null);
  };

  const toggleEnabled = async (candidate: RssRuleMatchCandidate, enabled: boolean) => {
    const previous = queryClient.getQueryData<RssRuleMatchCandidate[]>(candidatesKey);
    queryClient.setQueryData<RssRuleMatchCandidate[]>(candidatesKey, (prev) =>
      prev?.map((c) => (c.id === candidate.id ? { ...c, enabled } : c)),
    );
    try {
      await api.rss.updateCandidate(ruleId, candidate.id, { enabled });
    } catch (err) {
      if (previous) queryClient.setQueryData(candidatesKey, previous);
      toast.error('Could not update candidate', err instanceof ApiError ? err.message : undefined);
    }
  };

  const deleteCandidate = async (candidate: RssRuleMatchCandidate) => {
    if (!confirm(`Delete candidate "${candidate.name}"?`)) return;
    try {
      await api.rss.deleteCandidate(ruleId, candidate.id);
      toast.success('Candidate deleted', candidate.name);
      invalidate();
    } catch (err) {
      toast.error('Could not delete candidate', err instanceof ApiError ? err.message : undefined);
    }
  };

  const convertToRegex = async (candidate: RssRuleMatchCandidate) => {
    if (!candidate.pattern) return;
    try {
      const { pattern } = await api.rss.convertToRegex(candidate.pattern);
      await api.rss.updateCandidate(ruleId, candidate.id, { matchType: 'regex', pattern });
      toast.success('Converted to regex', pattern);
      invalidate();
    } catch (err) {
      toast.error('Could not convert pattern', err instanceof ApiError ? err.message : undefined);
    }
  };

  const addFallback = (candidate: RssRuleMatchCandidate) => {
    const source: RssRuleMatchCandidate = {
      ...candidate,
      name: `${candidate.name} (fallback)`,
      pattern: candidate.pattern,
    };
    setEditor({ mode: 'create', source });
  };

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/rss')} className="mb-2 -ml-2">
          <ArrowLeft className="h-4 w-4" /> Back to RSS
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Match preferences{rule ? ` — ${rule.name}` : ''}
            </h1>
            <p className="text-sm text-muted-foreground">
              {feed ? `Feed: ${feed.name}. ` : ''}
              Candidates are evaluated top-to-bottom; the first match wins.
            </p>
          </div>
          <Button onClick={() => setEditor({ mode: 'create', source: null })}>
            <Plus className="h-4 w-4" /> Add candidate
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="smart">Smart Build</TabsTrigger>
          <TabsTrigger value="test">Test</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="preferences" className="mt-4">
          {isLoading ? (
            <CenteredSpinner label="Loading candidates…" />
          ) : isError ? (
            <ErrorState message="Could not load match candidates." onRetry={() => refetch()} />
          ) : !candidates || candidates.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={<ListFilter className="h-6 w-6" />}
                  title="No match candidates"
                  description="Add candidates to control which releases this rule downloads and in what order of preference."
                  action={
                    <Button onClick={() => setEditor({ mode: 'create', source: null })}>
                      <Plus className="h-4 w-4" /> Add your first candidate
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {candidates.map((candidate, index) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  index={index}
                  isFirst={index === 0}
                  isLast={index === candidates.length - 1}
                  isDragging={dragId === candidate.id}
                  isDragOver={overId === candidate.id}
                  onEdit={() => setEditor({ mode: 'edit', source: candidate })}
                  onDuplicate={() => setEditor({ mode: 'create', source: candidate })}
                  onDelete={() => void deleteCandidate(candidate)}
                  onToggleEnabled={(enabled) => void toggleEnabled(candidate, enabled)}
                  onConvertToRegex={() => void convertToRegex(candidate)}
                  onAddFallback={() => addFallback(candidate)}
                  onMoveUp={() => moveBy(candidate.id, -1)}
                  onMoveDown={() => moveBy(candidate.id, 1)}
                  onDragStart={() => setDragId(candidate.id)}
                  onDragEnter={() => setOverId(candidate.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                  onDrop={() => handleDrop(candidate.id)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="smart" className="mt-4">
          <SmartMatchBuilder
            ruleId={ruleId}
            onApplied={() => {
              invalidate();
              setTab('preferences');
            }}
          />
        </TabsContent>

        <TabsContent value="test" className="mt-4">
          <TestingPanel ruleId={ruleId} candidates={candidates ?? []} />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <MatchHistoryPanel ruleId={ruleId} />
        </TabsContent>
      </Tabs>

      {editor && (
        <CandidateEditorDialog
          ruleId={ruleId}
          feeds={feeds}
          candidate={editor.source}
          mode={editor.mode}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}
