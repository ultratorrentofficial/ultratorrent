import { useState } from 'react';
import {
  ApiError,
  api,
  type CandidateInput,
  type MatchType,
  type RssFeed,
  type RssRuleMatchCandidate,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MATCH_TYPE_OPTIONS, TermInput } from './shared';

interface FormState {
  name: string;
  description: string;
  enabled: boolean;
  matchType: MatchType;
  pattern: string;
  requiredTerms: string[];
  excludedTerms: string[];
  quality: string;
  source: string;
  codec: string;
  resolution: string;
  season: string;
  episode: string;
  year: string;
  minMb: string;
  maxMb: string;
  feedIds: string[];
}

const bytesToMb = (bytes?: number): string =>
  bytes != null && Number.isFinite(bytes) ? String(Math.round(bytes / (1024 * 1024))) : '';

const mbToBytes = (mb: string): number | undefined => {
  const n = Number(mb);
  return mb.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1024 * 1024) : undefined;
};

const numOrUndef = (raw: string): number | undefined => {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) ? n : undefined;
};

function fromCandidate(c: RssRuleMatchCandidate | null): FormState {
  return {
    name: c?.name ?? '',
    description: c?.description ?? '',
    enabled: c?.enabled ?? true,
    matchType: c?.matchType ?? 'contains_text',
    pattern: c?.pattern ?? '',
    requiredTerms: c?.requiredTerms ?? [],
    excludedTerms: c?.excludedTerms ?? [],
    quality: c?.qualityRules?.quality ?? '',
    source: c?.qualityRules?.source ?? '',
    codec: c?.qualityRules?.codec ?? '',
    resolution: c?.qualityRules?.resolution ?? '',
    season: c?.qualityRules?.season != null ? String(c.qualityRules.season) : '',
    episode: c?.qualityRules?.episode != null ? String(c.qualityRules.episode) : '',
    year: c?.qualityRules?.year != null ? String(c.qualityRules.year) : '',
    minMb: bytesToMb(c?.sizeRules?.minBytes),
    maxMb: bytesToMb(c?.sizeRules?.maxBytes),
    feedIds: c?.feedScope?.feedIds ?? [],
  };
}

function toInput(f: FormState): CandidateInput {
  const qualityRules = {
    ...(f.quality.trim() ? { quality: f.quality.trim() } : {}),
    ...(f.source.trim() ? { source: f.source.trim() } : {}),
    ...(f.codec.trim() ? { codec: f.codec.trim() } : {}),
    ...(f.resolution.trim() ? { resolution: f.resolution.trim() } : {}),
    ...(numOrUndef(f.season) != null ? { season: numOrUndef(f.season) } : {}),
    ...(numOrUndef(f.episode) != null ? { episode: numOrUndef(f.episode) } : {}),
    ...(numOrUndef(f.year) != null ? { year: numOrUndef(f.year) } : {}),
  };
  const sizeRules = {
    ...(mbToBytes(f.minMb) != null ? { minBytes: mbToBytes(f.minMb) } : {}),
    ...(mbToBytes(f.maxMb) != null ? { maxBytes: mbToBytes(f.maxMb) } : {}),
  };
  return {
    name: f.name.trim(),
    description: f.description.trim() || undefined,
    enabled: f.enabled,
    matchType: f.matchType,
    pattern: f.pattern.trim() || undefined,
    requiredTerms: f.requiredTerms,
    excludedTerms: f.excludedTerms,
    qualityRules,
    sizeRules,
    feedScope: { feedIds: f.feedIds },
  };
}

const PATTERN_HINT: Partial<Record<MatchType, string>> = {
  exact_text: 'Title must equal this exactly (case-insensitive).',
  contains_text: 'Title must contain every word here (any order); gaps like an episode number are ignored.',
  regex: 'JavaScript regular expression, matched against the title.',
  wildcard: 'Use * and ? wildcards, e.g. *1080p*WEB-DL*.',
  smart_episode_match: 'Series name; season/episode handled via quality rules.',
  smart_movie_match: 'Movie name; year handled via quality rules.',
  fuzzy_match: 'Approximate title; minor differences are tolerated.',
};

export function CandidateEditorDialog({
  ruleId,
  feeds,
  candidate,
  mode,
  onClose,
  onSaved,
}: {
  ruleId: string;
  feeds: RssFeed[];
  /** Source candidate for edit, or the candidate to clone for duplicate. */
  candidate: RssRuleMatchCandidate | null;
  mode: 'create' | 'edit';
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => fromCandidate(candidate));
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const toggleFeed = (feedId: string) =>
    setForm((prev) => ({
      ...prev,
      feedIds: prev.feedIds.includes(feedId)
        ? prev.feedIds.filter((id) => id !== feedId)
        : [...prev.feedIds, feedId],
    }));

  const submit = async () => {
    setSaving(true);
    try {
      const body = toInput(form);
      if (mode === 'edit' && candidate) {
        const updated = await api.rss.updateCandidate(ruleId, candidate.id, body);
        const grabbed = updated.backfill?.downloaded ?? 0;
        toast.success(
          'Candidate updated',
          grabbed > 0
            ? `${body.name} — downloaded ${grabbed} matching item${grabbed === 1 ? '' : 's'} from history`
            : body.name,
        );
      } else {
        const created = await api.rss.createCandidate(ruleId, body);
        const grabbed = created.backfill?.downloaded ?? 0;
        toast.success(
          'Candidate added',
          grabbed > 0
            ? `${body.name} — downloaded ${grabbed} matching item${grabbed === 1 ? '' : 's'} from history`
            : body.name,
        );
      }
      onSaved();
    } catch (err) {
      toast.error(
        mode === 'edit' ? 'Could not update candidate' : 'Could not add candidate',
        err instanceof ApiError ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {mode === 'edit' ? 'Edit candidate' : candidate ? 'Duplicate candidate' : 'Add candidate'}
        </DialogTitle>
        <DialogDescription>
          Candidates are evaluated in priority order; the first one that matches wins.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-2">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="cand-name">Name</Label>
            <Input
              id="cand-name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. 1080p WEB-DL preferred"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="cand-desc">Description</Label>
            <Textarea
              id="cand-desc"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Optional note about what this candidate targets."
              className="min-h-[60px]"
            />
          </div>
          <div>
            <Label htmlFor="cand-type">Match type</Label>
            <Select
              id="cand-type"
              value={form.matchType}
              onChange={(e) => set('matchType', e.target.value as MatchType)}
              options={MATCH_TYPE_OPTIONS}
            />
          </div>
          <div className="flex items-end justify-between rounded-md border border-border/60 bg-white/[0.02] px-3 py-2">
            <Label htmlFor="cand-enabled">Enabled</Label>
            <Switch
              id="cand-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => set('enabled', v)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="cand-pattern">Pattern</Label>
            <Input
              id="cand-pattern"
              value={form.pattern}
              onChange={(e) => set('pattern', e.target.value)}
              placeholder="Show.Name.S01"
              className="font-mono"
            />
            {PATTERN_HINT[form.matchType] && (
              <p className="mt-1 text-xs text-muted-foreground">{PATTERN_HINT[form.matchType]}</p>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Required terms</Label>
            <TermInput
              value={form.requiredTerms}
              onChange={(v) => set('requiredTerms', v)}
              placeholder="add term, press Enter"
              tone="success"
            />
          </div>
          <div>
            <Label>Excluded terms</Label>
            <TermInput
              value={form.excludedTerms}
              onChange={(v) => set('excludedTerms', v)}
              placeholder="add term, press Enter"
              tone="destructive"
            />
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-border/60 p-3">
          <p className="text-sm font-medium">Quality rules</p>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <Label htmlFor="cand-quality">Quality</Label>
              <Input id="cand-quality" value={form.quality} onChange={(e) => set('quality', e.target.value)} placeholder="WEB-DL" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cand-source">Source</Label>
              <Input id="cand-source" value={form.source} onChange={(e) => set('source', e.target.value)} placeholder="BluRay" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cand-codec">Codec</Label>
              <Input id="cand-codec" value={form.codec} onChange={(e) => set('codec', e.target.value)} placeholder="x265" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cand-res">Resolution</Label>
              <Input id="cand-res" value={form.resolution} onChange={(e) => set('resolution', e.target.value)} placeholder="1080p" />
            </div>
            <div>
              <Label htmlFor="cand-season">Season</Label>
              <Input id="cand-season" type="number" value={form.season} onChange={(e) => set('season', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="cand-episode">Episode</Label>
              <Input id="cand-episode" type="number" value={form.episode} onChange={(e) => set('episode', e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cand-year">Year</Label>
              <Input id="cand-year" type="number" value={form.year} onChange={(e) => set('year', e.target.value)} />
            </div>
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-border/60 p-3">
          <p className="text-sm font-medium">Size rules</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="cand-min">Min size (MB)</Label>
              <Input id="cand-min" type="number" min={0} value={form.minMb} onChange={(e) => set('minMb', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="cand-max">Max size (MB)</Label>
              <Input id="cand-max" type="number" min={0} value={form.maxMb} onChange={(e) => set('maxMb', e.target.value)} />
            </div>
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-border/60 p-3">
          <p className="text-sm font-medium">Feed scope</p>
          <p className="text-xs text-muted-foreground">
            Limit this candidate to specific feeds. Leave all unchecked to apply to every feed.
          </p>
          <div className="space-y-2">
            {feeds.length === 0 ? (
              <p className="text-xs text-muted-foreground">No feeds available.</p>
            ) : (
              feeds.map((feed) => (
                <label key={feed.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.feedIds.includes(feed.id)}
                    onCheckedChange={() => toggleFeed(feed.id)}
                    aria-label={feed.name}
                  />
                  <span className="truncate">{feed.name}</span>
                </label>
              ))
            )}
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={saving} disabled={!form.name.trim()}>
          {mode === 'edit' ? 'Save changes' : 'Add candidate'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
