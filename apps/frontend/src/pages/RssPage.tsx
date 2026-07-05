import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
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
  type RssImportMode,
  type RssRule,
  type UpdateFeedInput,
  type UpdateRuleInput,
} from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { cn, safeHttpUrl } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { PathPicker } from '@/components/PathPicker';
import { useEnsureDirectory } from '@/components/path/EnsureDirectory';
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

// Turn a feed name into a safe, readable download-filename fragment.
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'feed';
}

export function RssPage() {
  const { t } = useTranslation('rss');
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [addFeedOpen, setAddFeedOpen] = useState(false);
  const [editFeed, setEditFeed] = useState<RssFeed | null>(null);
  const [ruleForFeed, setRuleForFeed] = useState<RssFeed | null>(null);
  const [editRule, setEditRule] = useState<{ feed: RssFeed; rule: RssRule } | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingFeedId, setExportingFeedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ bundle: unknown; name: string } | null>(
    null,
  );
  const [importMode, setImportMode] = useState<RssImportMode>('skip');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Trigger a browser download of a bundle as pretty-printed JSON.
  const saveBundle = (bundle: { rules: unknown[] }, filename: string) => {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportRules = async () => {
    setExporting(true);
    try {
      const bundle = await api.rss.exportRules();
      saveBundle(bundle, 'ultratorrent-rss-rules.json');
      toast.success(
        t('feeds.toast.exported'),
        t('feeds.toast.rulesCount', { count: bundle.rules.length }),
      );
    } catch (err) {
      toast.error(t('feeds.toast.exportFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setExporting(false);
    }
  };

  // Export just one feed's rules — a portable bundle scoped to that feed.
  const exportFeed = async (feed: RssFeed) => {
    setExportingFeedId(feed.id);
    try {
      const bundle = await api.rss.exportFeedRules(feed.id);
      saveBundle(bundle, `ultratorrent-rss-${slugify(feed.name)}.json`);
      toast.success(
        t('feeds.toast.exported'),
        t('feeds.toast.rulesCount', { count: bundle.rules.length }),
      );
    } catch (err) {
      toast.error(t('feeds.toast.exportFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setExportingFeedId(null);
    }
  };

  // Parse the file, then let the user pick how duplicates are handled before
  // actually importing.
  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      setImportMode('skip');
      setPendingImport({ bundle, name: file.name });
    } catch {
      toast.error(t('feeds.toast.importFailed'), t('feeds.toast.invalidJson'));
    }
  };

  const doImport = async () => {
    if (!pendingImport) return;
    setImporting(true);
    try {
      const s = await api.rss.importRules(pendingImport.bundle, importMode);
      const parts: string[] = [];
      if (s.rulesCreated) parts.push(t('feeds.toast.rulesCount', { count: s.rulesCreated }));
      if (s.rulesOverwritten)
        parts.push(t('feeds.toast.overwrittenCount', { count: s.rulesOverwritten }));
      if (s.rulesMerged) parts.push(t('feeds.toast.mergedCount', { count: s.rulesMerged }));
      if (s.candidatesCreated)
        parts.push(t('feeds.toast.filtersCount', { count: s.candidatesCreated }));
      if (s.feedsCreated) parts.push(t('feeds.toast.feedsCount', { count: s.feedsCreated }));
      if (s.rulesSkipped) parts.push(t('feeds.toast.skippedCount', { count: s.rulesSkipped }));
      toast.success(
        t('feeds.toast.imported'),
        parts.length ? parts.join(', ') : t('feeds.toast.nothingImported'),
      );
      invalidate();
      setPendingImport(null);
    } catch (err) {
      toast.error(t('feeds.toast.importFailed'), err instanceof ApiError ? err.message : undefined);
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
    if (!confirm(t('feeds.confirmDeleteFeed', { name: feed.name }))) return;
    try {
      await api.rss.deleteFeed(feed.id);
      toast.success(t('feeds.toast.feedDeleted'), feed.name);
      invalidate();
    } catch (err) {
      toast.error(t('feeds.toast.deleteFeedFailed'), err instanceof ApiError ? err.message : undefined);
    }
  };

  const refreshFeed = async (feed: RssFeed) => {
    setRefreshingId(feed.id);
    try {
      const { newItems, downloaded } = await api.rss.refreshFeed(feed.id);
      toast.success(
        t('feeds.toast.feedFetched'),
        newItems === 0
          ? t('feeds.toast.noNewItems')
          : t('feeds.toast.newItems', { count: newItems }) +
              (downloaded > 0 ? t('feeds.toast.downloadedSuffix', { count: downloaded }) : ''),
      );
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['rss', 'history', feed.id] });
    } catch (err) {
      toast.error(t('feeds.toast.fetchFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setRefreshingId(null);
    }
  };

  const deleteRule = async (ruleId: string, ruleName: string) => {
    try {
      await api.rss.deleteRule(ruleId);
      toast.success(t('feeds.toast.ruleDeleted'), ruleName);
      invalidate();
    } catch (err) {
      toast.error(t('feeds.toast.deleteRuleFailed'), err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('feeds.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('feeds.subtitle')}
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
            <Upload className="h-4 w-4" /> {t('feeds.import')}
          </Button>
          <Button variant="secondary" onClick={() => void exportRules()} loading={exporting}>
            <Download className="h-4 w-4" /> {t('feeds.export')}
          </Button>
          <Button onClick={() => setAddFeedOpen(true)}>
            <Plus className="h-4 w-4" /> {t('feeds.addFeed')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <CenteredSpinner label={t('feeds.loading')} />
      ) : isError ? (
        <ErrorState message={t('feeds.loadError')} onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Rss className="h-6 w-6" />}
              title={t('feeds.empty.title')}
              description={t('feeds.empty.description')}
              action={
                <Button onClick={() => setAddFeedOpen(true)}>
                  <Plus className="h-4 w-4" /> {t('feeds.addFirstFeed')}
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
                        {feed.isEnabled ? t('feeds.active') : t('feeds.paused')}
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
                        <Clock className="h-3 w-3" /> {t('feeds.everyInterval', { interval: minutes(feed.refreshInterval) })}
                      </span>
                      <span>{t('feeds.checked', { time: formatRelativeTime(feed.lastFetchedAt) })}</span>
                      <span>{t('feeds.ruleCount', { count: rules.length })}</span>
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
                      <RefreshCw className="h-4 w-4" /> {t('feeds.fetchNow')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/rss/feeds/${feed.id}/history`)}
                    >
                      <History className="h-4 w-4" /> {t('feeds.history')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('feeds.exportFeed')}
                      title={t('feeds.exportFeed')}
                      onClick={() => void exportFeed(feed)}
                      loading={exportingFeedId === feed.id}
                      disabled={exportingFeedId !== null || rules.length === 0}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('feeds.editFeed')}
                      onClick={() => setEditFeed(feed)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('feeds.deleteFeed')}
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
                      {t('feeds.noRules')}
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
                                <Download className="h-3 w-3" /> {t('feeds.auto')}
                              </Badge>
                            )}
                            {linked && (
                              <Badge variant="secondary">
                                <Link2 className="h-3 w-3" /> {t('feeds.fromFeed', { feed: feedName(rule.feedId) ?? t('feeds.anotherFeed') })}
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
                            <SlidersHorizontal className="h-4 w-4" /> {t('feeds.matchPreferences')}
                          </Button>
                          {/* Edit/Delete belong to the owner feed. On a linked
                              feed the rule is a read-only projection. */}
                          {!linked && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('feeds.editRule')}
                                onClick={() => setEditRule({ feed, rule })}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('feeds.deleteRule')}
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
                    <Plus className="h-4 w-4" /> {t('feeds.addRule')}
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

      {pendingImport && (
        <Dialog
          open
          onClose={() => {
            if (!importing) setPendingImport(null);
          }}
          className="max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>{t('feeds.importDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('feeds.importDialog.description', { name: pendingImport.name })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {(['skip', 'overwrite', 'merge'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setImportMode(m)}
                className={cn(
                  'w-full rounded-md border p-3 text-left transition-colors',
                  importMode === m
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border/60 hover:bg-white/[0.02]',
                )}
              >
                <p className="text-sm font-medium">{t(`feeds.importDialog.mode.${m}.label`)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(`feeds.importDialog.mode.${m}.desc`)}
                </p>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingImport(null)} disabled={importing}>
              {t('feeds.importDialog.cancel')}
            </Button>
            <Button onClick={() => void doImport()} loading={importing}>
              <Upload className="h-4 w-4" /> {t('feeds.importDialog.confirm')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function AddFeedDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('rss');
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
      toast.success(t('feedDialog.toast.added'), body.name);
      onSaved();
    } catch (err) {
      toast.error(t('feedDialog.toast.addFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{t('feedDialog.addTitle')}</DialogTitle>
        <DialogDescription>{t('feedDialog.addDescription')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="feed-name">{t('feedDialog.name')}</Label>
          <Input id="feed-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('feedDialog.namePlaceholder')} />
        </div>
        <div>
          <Label htmlFor="feed-url">{t('feedDialog.url')}</Label>
          <Input id="feed-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('feedDialog.urlPlaceholder')} />
        </div>
        <div>
          <Label htmlFor="feed-interval">{t('feedDialog.interval')}</Label>
          <Input
            id="feed-interval"
            type="number"
            min={1}
            value={intervalMin}
            onChange={(e) => setIntervalMin(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="feed-enabled">{t('feedDialog.enabled')}</Label>
          <Switch id="feed-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('feedDialog.cancel')}</Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim() || !url.trim()}>
          {t('feedDialog.addSubmit')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function EditFeedDialog({ feed, onClose, onSaved }: { feed: RssFeed; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('rss');
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
      toast.success(t('feedDialog.toast.updated'), body.name);
      onSaved();
    } catch (err) {
      toast.error(t('feedDialog.toast.updateFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{t('feedDialog.editTitle')}</DialogTitle>
        <DialogDescription>{t('feedDialog.editDescription')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="edit-feed-name">{t('feedDialog.name')}</Label>
          <Input id="edit-feed-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('feedDialog.namePlaceholder')} />
        </div>
        <div>
          <Label htmlFor="edit-feed-url">{t('feedDialog.url')}</Label>
          <Input id="edit-feed-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('feedDialog.urlPlaceholder')} />
        </div>
        <div>
          <Label htmlFor="edit-feed-interval">{t('feedDialog.interval')}</Label>
          <Input
            id="edit-feed-interval"
            type="number"
            min={1}
            value={intervalMin}
            onChange={(e) => setIntervalMin(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="edit-feed-enabled">{t('feedDialog.enabled')}</Label>
          <Switch id="edit-feed-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('feedDialog.cancel')}</Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim() || !url.trim()}>
          {t('feedDialog.saveSubmit')}
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
  const { t } = useTranslation('rss');
  const toast = useToast();
  const { ensure: ensureDirectory, dialog: ensureDirectoryDialog } = useEnsureDirectory();
  const editing = !!rule;
  const [name, setName] = useState(rule?.name ?? '');
  const [includeRegex, setIncludeRegex] = useState(rule?.includeRegex ?? '');
  const [excludeRegex, setExcludeRegex] = useState(rule?.excludeRegex ?? '');
  const [savePath, setSavePath] = useState(rule?.savePath ?? '');
  const [autoDownload, setAutoDownload] = useState(rule?.autoDownload ?? true);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    // Validate the save path against the hard roots and offer to create it if missing.
    if (savePath.trim() && !(await ensureDirectory(savePath))) return;
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
        toast.success(t('ruleDialog.toast.updated'), body.name);
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
        toast.success(t('ruleDialog.toast.added'), body.name);
      }
      onSaved();
    } catch (err) {
      toast.error(
        editing ? t('ruleDialog.toast.updateFailed') : t('ruleDialog.toast.addFailed'),
        err instanceof ApiError ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>
          {editing
            ? t('ruleDialog.editTitle', { name: rule.name })
            : t('ruleDialog.addTitle', { name: feed.name })}
        </DialogTitle>
        <DialogDescription>
          {autoDownload ? t('ruleDialog.descriptionAuto') : t('ruleDialog.descriptionManual')}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="rule-name">{t('ruleDialog.name')}</Label>
          <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ruleDialog.namePlaceholder')} />
        </div>
        <div>
          <Label htmlFor="rule-include">{t('ruleDialog.include')}</Label>
          <Input id="rule-include" value={includeRegex} onChange={(e) => setIncludeRegex(e.target.value)} placeholder={t('ruleDialog.includePlaceholder')} className="font-mono" />
        </div>
        <div>
          <Label htmlFor="rule-exclude">{t('ruleDialog.exclude')}</Label>
          <Input id="rule-exclude" value={excludeRegex} onChange={(e) => setExcludeRegex(e.target.value)} placeholder={t('ruleDialog.excludePlaceholder')} className="font-mono" />
        </div>
        <div>
          <Label htmlFor="rule-path">{t('ruleDialog.savePath')}</Label>
          <PathPicker
            id="rule-path"
            value={savePath}
            onChange={setSavePath}
            placeholder={t('ruleDialog.savePathPlaceholder')}
            aria-label={t('ruleDialog.savePathAria')}
            pickerTitle={t('ruleDialog.savePathPicker')}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="rule-auto">{t('ruleDialog.autoDownload')}</Label>
          <Switch id="rule-auto" checked={autoDownload} onCheckedChange={setAutoDownload} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('ruleDialog.cancel')}</Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim()}>
          {editing ? t('ruleDialog.saveSubmit') : t('ruleDialog.addSubmit')}
        </Button>
      </DialogFooter>
    </Dialog>
    {ensureDirectoryDialog}
    </>
  );
}

