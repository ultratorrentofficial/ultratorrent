import { useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  Download,
  ExternalLink,
  Filter,
  FolderInput,
  History,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ApiError,
  api,
  type CreateFeedInput,
  type CreateRuleInput,
  type RssFeed,
  type RssRule,
  type UpdateFeedInput,
  type UpdateRuleInput,
} from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { safeHttpUrl } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { PathPicker } from '@/components/PathPicker';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { rulesForFeed } from './rssGrouping';

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`;
}

export function RssPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [addFeedOpen, setAddFeedOpen] = useState(false);
  const [editFeed, setEditFeed] = useState<RssFeed | null>(null);
  const [ruleForFeed, setRuleForFeed] = useState<RssFeed | null>(null);
  const [editRule, setEditRule] = useState<{ feed: RssFeed; rule: RssRule } | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportRules = async () => {
    setExporting(true);
    try {
      const bundle = await api.rss.exportRules();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ultratorrent-rss-rules.json';
      a.click();
      URL.revokeObjectURL(url);
      toast.success(
        'Rules exported',
        `${bundle.rules.length} rule${bundle.rules.length === 1 ? '' : 's'}`,
      );
    } catch (err) {
      toast.error('Export failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setExporting(false);
    }
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setImporting(true);
    try {
      const bundle = JSON.parse(await file.text());
      const s = await api.rss.importRules(bundle);
      const parts = [
        `${s.rulesCreated} rule${s.rulesCreated === 1 ? '' : 's'}`,
        `${s.candidatesCreated} filter${s.candidatesCreated === 1 ? '' : 's'}`,
      ];
      if (s.feedsCreated) parts.push(`${s.feedsCreated} feed${s.feedsCreated === 1 ? '' : 's'}`);
      if (s.rulesSkipped) parts.push(`${s.rulesSkipped} skipped`);
      toast.success('Rules imported', parts.join(', '));
      invalidate();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof SyntaxError
            ? 'Not a valid JSON file'
            : undefined;
      toast.error('Import failed', msg);
    } finally {
      setImporting(false);
    }
  };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['rss'],
    queryFn: api.rss.list,
    refetchInterval: 30000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['rss'] });

  // A rule is owned by one feed but, via its candidates' feed scope, can target
  // several. Regroup so every rule shows under each feed it targets. Each rule
  // is owned once, so flattening never duplicates.
  const feeds = data ?? [];
  const allRules = feeds.flatMap((f) => f.rules);
  const feedName = (id: string): string | undefined => feeds.find((f) => f.id === id)?.name;

  const deleteFeed = async (feed: RssFeed) => {
    if (!confirm(`Delete feed "${feed.name}" and its rules?`)) return;
    try {
      await api.rss.deleteFeed(feed.id);
      toast.success('Feed deleted', feed.name);
      invalidate();
    } catch (err) {
      toast.error('Could not delete feed', err instanceof ApiError ? err.message : undefined);
    }
  };

  const refreshFeed = async (feed: RssFeed) => {
    setRefreshingId(feed.id);
    try {
      const { newItems, downloaded } = await api.rss.refreshFeed(feed.id);
      toast.success(
        'Feed fetched',
        newItems === 0
          ? 'No new items.'
          : `${newItems} new item${newItems === 1 ? '' : 's'}` +
              (downloaded > 0 ? `, ${downloaded} downloaded` : ''),
      );
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['rss', 'history', feed.id] });
    } catch (err) {
      toast.error('Could not fetch feed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setRefreshingId(null);
    }
  };

  const deleteRule = async (ruleId: string, ruleName: string) => {
    try {
      await api.rss.deleteRule(ruleId);
      toast.success('Rule deleted', ruleName);
      invalidate();
    } catch (err) {
      toast.error('Could not delete rule', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">RSS feeds</h1>
          <p className="text-sm text-muted-foreground">
            Subscribed feeds are polled for new releases and matched against rules.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onImportFile}
          />
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            loading={importing}
          >
            <Upload className="h-4 w-4" /> Import
          </Button>
          <Button variant="secondary" onClick={() => void exportRules()} loading={exporting}>
            <Download className="h-4 w-4" /> Export
          </Button>
          <Button onClick={() => setAddFeedOpen(true)}>
            <Plus className="h-4 w-4" /> Add feed
          </Button>
        </div>
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading feeds…" />
      ) : isError ? (
        <ErrorState message="Could not load RSS feeds." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Rss className="h-6 w-6" />}
              title="No RSS feeds"
              description="Feeds you add are polled automatically and can drive download rules."
              action={
                <Button onClick={() => setAddFeedOpen(true)}>
                  <Plus className="h-4 w-4" /> Add your first feed
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {data.map((feed) => {
            const rules = rulesForFeed(allRules, feed.id);
            return (
            <Card key={feed.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-semibold">{feed.name}</p>
                      <Badge variant={feed.isEnabled ? 'success' : 'secondary'} dot>
                        {feed.isEnabled ? 'Active' : 'Paused'}
                      </Badge>
                    </div>
                    {(() => {
                      const safeUrl = safeHttpUrl(feed.url);
                      return safeUrl ? (
                        <a
                          href={safeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                        >
                          <span className="truncate">{feed.url}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      ) : (
                        // Unsafe (non-http(s)) URL: show as text, never as a link.
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {feed.url}
                        </span>
                      );
                    })()}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" /> every {minutes(feed.refreshInterval)}
                      </span>
                      <span>checked {formatRelativeTime(feed.lastFetchedAt)}</span>
                      <span>{rules.length} rule{rules.length === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void refreshFeed(feed)}
                      loading={refreshingId === feed.id}
                      disabled={refreshingId !== null}
                    >
                      <RefreshCw className="h-4 w-4" /> Fetch now
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/rss/feeds/${feed.id}/history`)}
                    >
                      <History className="h-4 w-4" /> History
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit feed"
                      onClick={() => setEditFeed(feed)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete feed"
                      onClick={() => deleteFeed(feed)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>

                {/* Rules */}
                <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
                  {rules.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No rules yet — this feed is logged but nothing is auto-downloaded.
                    </p>
                  ) : (
                    rules.map((rule) => {
                      // Shown here because a candidate's feed scope targets this
                      // feed, but the rule lives on another feed. Manage it there.
                      const linked = rule.feedId !== feed.id;
                      return (
                      <div
                        key={rule.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/[0.02] px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{rule.name}</span>
                            {rule.autoDownload && (
                              <Badge variant="info" dot>
                                <Download className="h-3 w-3" /> auto
                              </Badge>
                            )}
                            {linked && (
                              <Badge variant="secondary">
                                <Link2 className="h-3 w-3" /> from {feedName(rule.feedId) ?? 'another feed'}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {rule.includeRegex && (
                              <span className="inline-flex items-center gap-1">
                                <Filter className="h-3 w-3 text-success" />
                                <code className="font-mono">{rule.includeRegex}</code>
                              </span>
                            )}
                            {rule.excludeRegex && (
                              <span className="inline-flex items-center gap-1">
                                <Filter className="h-3 w-3 text-destructive" />
                                <code className="font-mono">!{rule.excludeRegex}</code>
                              </span>
                            )}
                            {rule.savePath && (
                              <span className="inline-flex items-center gap-1">
                                <FolderInput className="h-3 w-3" />
                                <code className="font-mono">{rule.savePath}</code>
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/rss/rules/${rule.id}`)}
                          >
                            <SlidersHorizontal className="h-4 w-4" /> Match preferences
                          </Button>
                          {/* Edit/Delete belong to the owner feed. On a linked
                              feed the rule is a read-only projection. */}
                          {!linked && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Edit rule"
                                onClick={() => setEditRule({ feed, rule })}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Delete rule"
                                onClick={() => deleteRule(rule.id, rule.name)}
                              >
                                <Trash2 className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      );
                    })
                  )}
                  <Button variant="subtle" size="sm" onClick={() => setRuleForFeed(feed)}>
                    <Plus className="h-4 w-4" /> Add rule
                  </Button>
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}

      {addFeedOpen && (
        <AddFeedDialog
          onClose={() => setAddFeedOpen(false)}
          onSaved={() => {
            setAddFeedOpen(false);
            invalidate();
          }}
        />
      )}
      {editFeed && (
        <EditFeedDialog
          feed={editFeed}
          onClose={() => setEditFeed(null)}
          onSaved={() => {
            setEditFeed(null);
            invalidate();
          }}
        />
      )}
      {ruleForFeed && (
        <RuleDialog
          feed={ruleForFeed}
          onClose={() => setRuleForFeed(null)}
          onSaved={() => {
            setRuleForFeed(null);
            invalidate();
          }}
        />
      )}
      {editRule && (
        <RuleDialog
          feed={editRule.feed}
          rule={editRule.rule}
          onClose={() => setEditRule(null)}
          onSaved={() => {
            setEditRule(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function AddFeedDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [intervalMin, setIntervalMin] = useState('15');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const body: CreateFeedInput = {
        name: name.trim(),
        url: url.trim(),
        refreshInterval: Math.max(60, Math.round(Number(intervalMin) * 60)),
        isEnabled: enabled,
      };
      await api.rss.createFeed(body);
      toast.success('Feed added', body.name);
      onSaved();
    } catch (err) {
      toast.error('Could not add feed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Add RSS feed</DialogTitle>
        <DialogDescription>The feed is polled on the interval you set.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="feed-name">Name</Label>
          <Input id="feed-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Linux ISOs" />
        </div>
        <div>
          <Label htmlFor="feed-url">Feed URL</Label>
          <Input id="feed-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/rss" />
        </div>
        <div>
          <Label htmlFor="feed-interval">Refresh interval (minutes)</Label>
          <Input
            id="feed-interval"
            type="number"
            min={1}
            value={intervalMin}
            onChange={(e) => setIntervalMin(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="feed-enabled">Enabled</Label>
          <Switch id="feed-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim() || !url.trim()}>
          Add feed
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function EditFeedDialog({ feed, onClose, onSaved }: { feed: RssFeed; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(feed.name);
  const [url, setUrl] = useState(feed.url);
  const [intervalMin, setIntervalMin] = useState(String(Math.round(feed.refreshInterval / 60)));
  const [enabled, setEnabled] = useState(feed.isEnabled);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const body: UpdateFeedInput = {
        name: name.trim(),
        url: url.trim(),
        refreshInterval: Math.max(60, Math.round(Number(intervalMin) * 60)),
        isEnabled: enabled,
      };
      await api.rss.updateFeed(feed.id, body);
      toast.success('Feed updated', body.name);
      onSaved();
    } catch (err) {
      toast.error('Could not update feed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Edit RSS feed</DialogTitle>
        <DialogDescription>Update the feed name, URL, polling interval, or enabled state.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="edit-feed-name">Name</Label>
          <Input id="edit-feed-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Linux ISOs" />
        </div>
        <div>
          <Label htmlFor="edit-feed-url">Feed URL</Label>
          <Input id="edit-feed-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/rss" />
        </div>
        <div>
          <Label htmlFor="edit-feed-interval">Refresh interval (minutes)</Label>
          <Input
            id="edit-feed-interval"
            type="number"
            min={1}
            value={intervalMin}
            onChange={(e) => setIntervalMin(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="edit-feed-enabled">Enabled</Label>
          <Switch id="edit-feed-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim() || !url.trim()}>
          Save changes
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function RuleDialog({
  feed,
  rule,
  onClose,
  onSaved,
}: {
  feed: RssFeed;
  /** When provided, the dialog edits this rule instead of creating a new one. */
  rule?: RssRule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const editing = !!rule;
  const [name, setName] = useState(rule?.name ?? '');
  const [includeRegex, setIncludeRegex] = useState(rule?.includeRegex ?? '');
  const [excludeRegex, setExcludeRegex] = useState(rule?.excludeRegex ?? '');
  const [savePath, setSavePath] = useState(rule?.savePath ?? '');
  const [autoDownload, setAutoDownload] = useState(rule?.autoDownload ?? true);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      if (editing) {
        // Send trimmed values incl. empty strings so cleared patterns persist.
        const body: UpdateRuleInput = {
          name: name.trim(),
          includeRegex: includeRegex.trim(),
          excludeRegex: excludeRegex.trim(),
          savePath: savePath.trim(),
          autoDownload,
        };
        await api.rss.updateRule(rule.id, body);
        toast.success('Rule updated', body.name);
      } else {
        const body: CreateRuleInput = {
          feedId: feed.id,
          name: name.trim(),
          includeRegex: includeRegex.trim() || undefined,
          excludeRegex: excludeRegex.trim() || undefined,
          savePath: savePath.trim() || undefined,
          autoDownload,
        };
        await api.rss.createRule(body);
        toast.success('Rule added', body.name);
      }
      onSaved();
    } catch (err) {
      toast.error(
        editing ? 'Could not update rule' : 'Could not add rule',
        err instanceof ApiError ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>
          {editing ? `Edit rule — “${rule.name}”` : `Add rule to “${feed.name}”`}
        </DialogTitle>
        <DialogDescription>
          Matched items {autoDownload ? 'are downloaded automatically' : 'are recorded only'}.
          Regexes are case-insensitive and matched against the item title.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="rule-name">Name</Label>
          <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 1080p only" />
        </div>
        <div>
          <Label htmlFor="rule-include">Include regex</Label>
          <Input id="rule-include" value={includeRegex} onChange={(e) => setIncludeRegex(e.target.value)} placeholder="1080p" className="font-mono" />
        </div>
        <div>
          <Label htmlFor="rule-exclude">Exclude regex</Label>
          <Input id="rule-exclude" value={excludeRegex} onChange={(e) => setExcludeRegex(e.target.value)} placeholder="(CAM|TS)" className="font-mono" />
        </div>
        <div>
          <Label htmlFor="rule-path">Save path (optional)</Label>
          <PathPicker
            id="rule-path"
            value={savePath}
            onChange={setSavePath}
            placeholder="/downloads/movies"
            aria-label="Save path"
            pickerTitle="Choose a save folder"
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="rule-auto">Auto-download matches</Label>
          <Switch id="rule-auto" checked={autoDownload} onCheckedChange={setAutoDownload} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim()}>
          {editing ? 'Save changes' : 'Add rule'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

