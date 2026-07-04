import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  FileText,
  Film,
  History,
  Image as ImageIcon,
  RotateCw,
  Save,
  Search,
  Sparkles,
  Star,
  Subtitles,
  Undo2,
  Upload,
} from 'lucide-react';
import {
  ApiError,
  api,
  type ImdbSearchResult,
  type MediaArtwork,
  type MediaItemDetail,
  type MediaMetadata,
  type MediaMetadataUpdateInput,
} from '@/lib/api';
import { formatBytes, formatNumber } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import {
  ARTWORK_TYPE_OPTIONS,
  IMDB_TITLE_KIND_OPTIONS,
  artworkTypeLabel,
  imdbTitleUrl,
  matchStatusLabel,
  matchStatusVariant,
  mediaTypeLabel,
  seasonEpisodeLabel,
} from './constants';

export function MediaDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'items', id],
    queryFn: () => api.media.getItem(id),
    enabled: Boolean(id),
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <CenteredSpinner label="Loading item…" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-6">
        <ErrorState message="Could not load this media item." onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media/items')} className="mb-2 -ml-2">
          Media Items
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{data.title}</h1>
          <Badge variant="secondary">{mediaTypeLabel(data.mediaType)}</Badge>
          <Badge variant={matchStatusVariant(data.matchStatus)} dot>
            {matchStatusLabel(data.matchStatus)}
          </Badge>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">{data.path}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto scrollbar-thin">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="metadata">Metadata</TabsTrigger>
            <TabsTrigger value="artwork">Artwork</TabsTrigger>
            <TabsTrigger value="subtitles">Subtitles</TabsTrigger>
            <TabsTrigger value="rename">Rename</TabsTrigger>
            <TabsTrigger value="nfo">NFO</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab item={data} />
        </TabsContent>
        <TabsContent value="files" className="mt-4">
          <FilesTab item={data} />
        </TabsContent>
        <TabsContent value="metadata" className="mt-4">
          <MetadataTab item={data} />
        </TabsContent>
        <TabsContent value="artwork" className="mt-4">
          <ArtworkTab itemId={data.id} />
        </TabsContent>
        <TabsContent value="subtitles" className="mt-4">
          <SubtitlesTab itemId={data.id} />
        </TabsContent>
        <TabsContent value="rename" className="mt-4">
          <RenameTab item={data} />
        </TabsContent>
        <TabsContent value="nfo" className="mt-4">
          <NfoTab item={data} />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <ItemHistoryTab item={data} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm">{value ?? '—'}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ item }: { item: MediaItemDetail }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canMatch = hasPermission(PERMISSIONS.MEDIA_MANAGER_MATCH);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['media', 'items', item.id] });

  const reidentify = useMutation({
    mutationFn: () => api.media.matchItem(item.id),
    onSuccess: (updated) => {
      toast.success('Re-identified', `${updated.title} — ${matchStatusLabel(updated.matchStatus)}.`);
      invalidate();
    },
    onError: (err) => toast.error('Could not re-identify', err instanceof ApiError ? err.message : undefined),
  });

  const unmatch = useMutation({
    mutationFn: () => api.media.unmatchItem(item.id),
    onSuccess: () => {
      toast.success('Unmatched', item.title);
      invalidate();
    },
    onError: (err) => toast.error('Could not unmatch', err instanceof ApiError ? err.message : undefined),
  });

  return (
    <div className="space-y-4">
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Title" value={item.title} />
          <Field label="Type" value={mediaTypeLabel(item.mediaType)} />
          <Field label="Year" value={item.year ?? '—'} />
          <Field label="Season / Episode" value={seasonEpisodeLabel(item.season, item.episode)} />
          <Field
            label="Match status"
            value={
              <Badge variant={matchStatusVariant(item.matchStatus)} dot>
                {matchStatusLabel(item.matchStatus)}
              </Badge>
            }
          />
          <Field label="Confidence" value={`${Math.round((item.confidence ?? 0) * 100)}%`} />
          <Field label="Library" value={item.library?.name ?? '—'} />
          {item.externalIds.length > 0 && (
            <Field
              label="External IDs"
              value={
                <span className="flex flex-wrap gap-1">
                  {item.externalIds.map((x) => (
                    <Badge key={x.id} variant="outline">
                      {x.provider}: {x.externalId}
                    </Badge>
                  ))}
                </span>
              }
            />
          )}
        </div>
        <Field label="Path" value={<span className="break-all font-mono text-xs">{item.path}</span>} />

        {canMatch && (
          <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
            <Button variant="secondary" onClick={() => reidentify.mutate()} loading={reidentify.isPending}>
              <RotateCw className="h-4 w-4" /> Re-identify
            </Button>
            {item.matchStatus !== 'unmatched' && (
              <Button variant="outline" onClick={() => unmatch.mutate()} loading={unmatch.isPending}>
                <Undo2 className="h-4 w-4" /> Unmatch
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
    <ImdbPanel item={item} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// IMDb
// ---------------------------------------------------------------------------

function ImdbPanel({ item }: { item: MediaItemDetail }) {
  const { hasPermission } = useAuth();
  const canMatch = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_MATCH);
  const canView = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_VIEW);
  const [matching, setMatching] = useState(false);

  const imdbExternal = item.externalIds.find((x) => x.provider === 'imdb');
  const imdbId = imdbExternal?.externalId ?? null;
  const meta = item.metadata;
  const isImdbRating = meta?.providerName === 'imdb' && meta.rating != null;

  // Show nothing when there's no IMDb linkage and the user can't act on it.
  if (!imdbId && !canView && !canMatch) return null;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Film className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-semibold">IMDb</h2>
          </div>
          {canMatch && (
            <Button size="sm" variant="outline" onClick={() => setMatching(true)}>
              <Search className="h-4 w-4" /> Match with IMDb
            </Button>
          )}
        </div>

        {imdbId ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field
              label="IMDb ID"
              value={
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-xs">{imdbId}</span>
                  <Badge variant="warning">IMDb</Badge>
                </span>
              }
            />
            {isImdbRating && (
              <Field
                label="IMDb rating"
                value={
                  <span className="flex items-center gap-1.5">
                    <Star className="h-4 w-4 text-warning" />
                    <span className="tabular-nums">{meta!.rating!.toFixed(1)}</span>
                    <span className="text-xs text-muted-foreground">/ 10</span>
                  </span>
                }
              />
            )}
            <Field
              label="Link"
              value={
                <a
                  href={imdbExternal?.url ?? imdbTitleUrl(imdbId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-info hover:underline"
                >
                  Open on IMDb <ExternalLink className="h-3.5 w-3.5" />
                </a>
              }
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This item is not linked to an IMDb title
            {canMatch ? ' — use “Match with IMDb” to search and link one.' : '.'}
          </p>
        )}
      </CardContent>

      {matching && (
        <ImdbMatchDialog item={item} onClose={() => setMatching(false)} />
      )}
    </Card>
  );
}

function ImdbMatchDialog({ item, onClose }: { item: MediaItemDetail; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(item.title);
  const [year, setYear] = useState(item.year != null ? String(item.year) : '');
  const [type, setType] = useState<string>(
    item.mediaType === 'tv' || item.mediaType === 'anime' ? 'tv' : item.mediaType === 'movie' ? 'movie' : 'any',
  );
  const [submitted, setSubmitted] = useState(false);

  const search = useQuery({
    queryKey: ['media', 'imdb', 'search', { title, year, type }],
    queryFn: () =>
      api.media.imdbSearch({
        title: title.trim(),
        year: year.trim() ? Number(year) : undefined,
        type: (type as 'movie' | 'tv' | 'episode' | 'any') || undefined,
      }),
    enabled: submitted && title.trim().length > 0,
  });

  const match = useMutation({
    mutationFn: (result: ImdbSearchResult) =>
      api.media.matchItemImdb(item.id, { imdbId: result.tconst, confidence: result.confidence }),
    onSuccess: (res) => {
      toast.success('Matched with IMDb', res.item.title);
      queryClient.invalidateQueries({ queryKey: ['media', 'items', item.id] });
      onClose();
    },
    onError: (err) => toast.error('Could not match', err instanceof ApiError ? err.message : undefined),
  });

  const results = search.data ?? [];

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Match with IMDb</DialogTitle>
        <DialogDescription>
          Search the IMDb provider and pick the correct title to link this item.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="grid gap-3 sm:grid-cols-[1fr,110px,130px,auto]">
          <div>
            <Label htmlFor="imdb-q-title">Title</Label>
            <Input
              id="imdb-q-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSubmitted(true);
              }}
            />
          </div>
          <div>
            <Label htmlFor="imdb-q-year">Year</Label>
            <Input
              id="imdb-q-year"
              type="number"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="imdb-q-type">Type</Label>
            <Select
              id="imdb-q-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={IMDB_TITLE_KIND_OPTIONS}
            />
          </div>
          <div className="flex items-end">
            <Button
              onClick={() => setSubmitted(true)}
              loading={search.isFetching}
              disabled={!title.trim()}
              className="w-full"
            >
              <Search className="h-4 w-4" /> Search
            </Button>
          </div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto scrollbar-thin">
          {!submitted ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Enter a title and search to see IMDb suggestions.
            </p>
          ) : search.isLoading || search.isFetching ? (
            <CenteredSpinner label="Searching IMDb…" />
          ) : search.isError ? (
            <ErrorState message="IMDb search failed." onRetry={() => search.refetch()} />
          ) : results.length === 0 ? (
            <EmptyState
              icon={<Film className="h-6 w-6" />}
              title="No results"
              description="No IMDb titles matched. Try adjusting the title, year, or type."
            />
          ) : (
            <ul className="divide-y divide-border/40">
              {results.map((r) => (
                <ImdbResultRow
                  key={r.tconst}
                  result={r}
                  onSelect={() => match.mutate(r)}
                  busy={match.isPending && match.variables?.tconst === r.tconst}
                  disabled={match.isPending}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ImdbResultRow({
  result,
  onSelect,
  busy,
  disabled,
}: {
  result: ImdbSearchResult;
  onSelect: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{result.primaryTitle}</span>
          {result.year != null && (
            <span className="text-xs text-muted-foreground">({result.year})</span>
          )}
          <Badge variant="warning">IMDb</Badge>
          <Badge variant="secondary">{result.titleType}</Badge>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{result.tconst}</span>
          {result.rating != null && (
            <span className="flex items-center gap-0.5">
              <Star className="h-3 w-3 text-warning" /> {result.rating.toFixed(1)}
            </span>
          )}
          {result.numVotes != null && <span>{formatNumber(result.numVotes)} votes</span>}
          <Badge variant={result.confidence >= 0.75 ? 'success' : result.confidence >= 0.5 ? 'info' : 'secondary'}>
            {Math.round(result.confidence * 100)}% match
          </Badge>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onSelect} loading={busy} disabled={disabled}>
        Select
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function FilesTab({ item }: { item: MediaItemDetail }) {
  if (item.files.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<FileText className="h-6 w-6" />}
            title="No files"
            description="This item has no scanned files yet."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto scrollbar-thin">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[280px] pl-4">Path</TableHead>
                <TableHead className="w-[100px]">Size</TableHead>
                <TableHead className="w-[100px]">Resolution</TableHead>
                <TableHead className="w-[90px]">Codec</TableHead>
                <TableHead className="w-[80px]">HDR</TableHead>
                <TableHead className="w-[110px] pr-4">Quality</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.files.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="pl-4">
                    <p className="truncate font-mono text-xs text-muted-foreground">{f.path}</p>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatBytes(Number(f.size))}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{f.resolution ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{f.videoCodec ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{f.hdr ?? '—'}</TableCell>
                  <TableCell className="pr-4 text-muted-foreground">{f.quality ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function MetadataTab({ item }: { item: MediaItemDetail }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission(PERMISSIONS.MEDIA_MANAGER_EDIT_METADATA);
  const meta = item.metadata;

  const [title, setTitle] = useState(meta?.title ?? '');
  const [overview, setOverview] = useState(meta?.overview ?? '');
  const [year, setYear] = useState(meta?.year != null ? String(meta.year) : '');
  const [runtime, setRuntime] = useState(meta?.runtime != null ? String(meta.runtime) : '');
  const [genres, setGenres] = useState((meta?.genres ?? []).join(', '));
  const [studios, setStudios] = useState((meta?.studios ?? []).join(', '));
  const [rating, setRating] = useState(meta?.rating != null ? String(meta.rating) : '');
  const [certification, setCertification] = useState(meta?.certification ?? '');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['media', 'items', item.id] });

  const fetchMeta = useMutation({
    mutationFn: () => api.media.fetchMetadata(item.id),
    onSuccess: (m: MediaMetadata) => {
      toast.success('Metadata fetched', m.providerName ? `via ${m.providerName}` : undefined);
      invalidate();
    },
    onError: (err) => toast.error('Could not fetch metadata', err instanceof ApiError ? err.message : undefined),
  });

  const save = useMutation({
    mutationFn: () => {
      const body: MediaMetadataUpdateInput = {
        title: title.trim() || undefined,
        overview: overview.trim() || undefined,
        year: year.trim() ? Number(year) : null,
        runtime: runtime.trim() ? Number(runtime) : null,
        genres: commaList(genres),
        studios: commaList(studios),
        rating: rating.trim() ? Number(rating) : null,
        certification: certification.trim() || null,
      };
      return api.media.updateMetadata(item.id, body);
    },
    onSuccess: () => {
      toast.success('Metadata saved');
      invalidate();
    },
    onError: (err) => toast.error('Could not save metadata', err instanceof ApiError ? err.message : undefined),
  });

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {meta?.providerName ? `Source: ${meta.providerName}` : 'No metadata fetched yet.'}
          </p>
          {canEdit && (
            <Button variant="secondary" onClick={() => fetchMeta.mutate()} loading={fetchMeta.isPending}>
              <Sparkles className="h-4 w-4" /> Fetch metadata
            </Button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="md-title">Title</Label>
            <Input id="md-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!canEdit} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="md-year">Year</Label>
              <Input id="md-year" type="number" value={year} onChange={(e) => setYear(e.target.value)} disabled={!canEdit} />
            </div>
            <div>
              <Label htmlFor="md-runtime">Runtime (min)</Label>
              <Input id="md-runtime" type="number" value={runtime} onChange={(e) => setRuntime(e.target.value)} disabled={!canEdit} />
            </div>
          </div>
        </div>

        <div>
          <Label htmlFor="md-overview">Overview</Label>
          <Textarea id="md-overview" value={overview} onChange={(e) => setOverview(e.target.value)} rows={4} disabled={!canEdit} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="md-genres">Genres (comma-separated)</Label>
            <Input id="md-genres" value={genres} onChange={(e) => setGenres(e.target.value)} disabled={!canEdit} />
          </div>
          <div>
            <Label htmlFor="md-studios">Studios (comma-separated)</Label>
            <Input id="md-studios" value={studios} onChange={(e) => setStudios(e.target.value)} disabled={!canEdit} />
          </div>
          <div>
            <Label htmlFor="md-rating">Rating</Label>
            <Input id="md-rating" type="number" step="0.1" value={rating} onChange={(e) => setRating(e.target.value)} disabled={!canEdit} />
          </div>
          <div>
            <Label htmlFor="md-cert">Certification</Label>
            <Input id="md-cert" value={certification} onChange={(e) => setCertification(e.target.value)} disabled={!canEdit} />
          </div>
        </div>

        <ImdbCredits meta={meta} />

        {canEdit && (
          <div className="flex justify-end border-t border-border/60 pt-4">
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              <Save className="h-4 w-4" /> Save metadata
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Read-only credits block, surfaced when IMDb (or another provider) supplied them. */
function ImdbCredits({ meta }: { meta: MediaMetadata | null | undefined }) {
  if (!meta) return null;
  const directors = meta.directors ?? [];
  const writers = meta.writers ?? [];
  const cast = meta.cast ?? [];
  if (directors.length === 0 && writers.length === 0 && cast.length === 0) return null;

  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold">Credits</p>
        {meta.providerName === 'imdb' && <Badge variant="warning">IMDb</Badge>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {directors.length > 0 && (
          <Field label="Directors" value={directors.join(', ')} />
        )}
        {writers.length > 0 && <Field label="Writers" value={writers.join(', ')} />}
      </div>
      {cast.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Cast</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {cast.slice(0, 24).map((c, i) => (
              <Badge key={`${c.name}-${i}`} variant="secondary">
                {c.name}
                {c.role ? ` — ${c.role}` : ''}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function ArtworkTab({ itemId }: { itemId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_MANAGER_MANAGE_ARTWORK);
  const [uploadType, setUploadType] = useState('poster');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'items', itemId, 'artwork'],
    queryFn: () => api.media.getItemArtwork(itemId),
  });
  const missingQuery = useQuery({
    queryKey: ['media', 'items', itemId, 'artwork', 'missing'],
    queryFn: () => api.media.missingArtwork(itemId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['media', 'items', itemId, 'artwork'] });
  };

  const select = useMutation({
    mutationFn: (artworkId: string) => api.media.selectArtwork(itemId, artworkId),
    onSuccess: () => {
      toast.success('Artwork selected');
      invalidate();
    },
    onError: (err) => toast.error('Could not select artwork', err instanceof ApiError ? err.message : undefined),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const dataBase64 = await readFileAsDataUrl(file);
      return api.media.uploadArtwork(itemId, { type: uploadType, filename: file.name, dataBase64 });
    },
    onSuccess: () => {
      toast.success('Artwork uploaded');
      invalidate();
    },
    onError: (err) => toast.error('Could not upload artwork', err instanceof ApiError ? err.message : undefined),
  });

  const byType = useMemo(() => {
    const map = new Map<string, MediaArtwork[]>();
    for (const a of data?.artwork ?? []) {
      const list = map.get(a.type) ?? [];
      list.push(a);
      map.set(a.type, list);
    }
    return map;
  }, [data]);

  if (isLoading) return <CenteredSpinner label="Loading artwork…" />;
  if (isError) return <ErrorState message="Could not load artwork." onRetry={() => refetch()} />;

  const missing = missingQuery.data?.missing ?? [];

  return (
    <div className="space-y-4">
      {canManage && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="min-w-[180px]">
              <Label htmlFor="art-type">Upload type</Label>
              <select
                id="art-type"
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
              >
                {ARTWORK_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = '';
              }}
            />
            <Button variant="secondary" onClick={() => fileInputRef.current?.click()} loading={upload.isPending}>
              <Upload className="h-4 w-4" /> Upload custom
            </Button>
          </CardContent>
        </Card>
      )}

      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <span>Missing:</span>
          {missing.map((t) => (
            <Badge key={t} variant="warning">
              {artworkTypeLabel(t)}
            </Badge>
          ))}
        </div>
      )}

      {(data?.artwork.length ?? 0) === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<ImageIcon className="h-6 w-6" />}
              title="No artwork"
              description="Fetch metadata or upload custom artwork to populate this item."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {[...byType.entries()].map(([type, arts]) => (
            <Card key={type}>
              <CardContent className="space-y-3 p-4">
                <p className="text-sm font-semibold">{artworkTypeLabel(type)}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
                  {arts.map((a) => (
                    <div
                      key={a.id}
                      className={`space-y-2 rounded-md border p-2 ${
                        a.selected ? 'border-primary' : 'border-border/60'
                      }`}
                    >
                      <div className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded bg-white/[0.03]">
                        {a.url || a.localPath ? (
                          <img
                            src={a.url ?? a.localPath ?? ''}
                            alt={type}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <ImageIcon className="h-6 w-6 text-muted-foreground" />
                        )}
                      </div>
                      {a.selected ? (
                        <Badge variant="success" className="w-full justify-center">
                          Selected
                        </Badge>
                      ) : (
                        canManage && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            onClick={() => select.mutate(a.id)}
                            loading={select.isPending && select.variables === a.id}
                          >
                            Select
                          </Button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

function SubtitlesTab({ itemId }: { itemId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MEDIA_MANAGER_MANAGE_SUBTITLES);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'items', itemId, 'subtitles'],
    queryFn: () => api.media.listSubtitles(itemId),
  });
  const missingQuery = useQuery({
    queryKey: ['media', 'items', itemId, 'subtitles', 'missing'],
    queryFn: () => api.media.missingSubtitles(itemId),
  });

  const scan = useMutation({
    mutationFn: () => api.media.scanSubtitles(itemId),
    onSuccess: () => {
      toast.success('Subtitle scan complete');
      queryClient.invalidateQueries({ queryKey: ['media', 'items', itemId, 'subtitles'] });
    },
    onError: (err) => toast.error('Could not scan subtitles', err instanceof ApiError ? err.message : undefined),
  });

  const missing = missingQuery.data?.missing ?? [];

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => scan.mutate()} loading={scan.isPending}>
            <Subtitles className="h-4 w-4" /> Scan subtitles
          </Button>
        </div>
      )}

      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <span>Missing languages:</span>
          {missing.map((l) => (
            <Badge key={l} variant="warning">
              {l}
            </Badge>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <CenteredSpinner label="Loading subtitles…" />
            </div>
          ) : isError ? (
            <div className="p-6">
              <ErrorState message="Could not load subtitles." onRetry={() => refetch()} />
            </div>
          ) : (data?.length ?? 0) === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Subtitles className="h-6 w-6" />}
                title="No subtitles"
                description="Scan to discover sidecar subtitle files next to this item."
              />
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px] pl-4">Language</TableHead>
                    <TableHead className="w-[90px]">Forced</TableHead>
                    <TableHead className="w-[90px]">SDH</TableHead>
                    <TableHead className="min-w-[280px] pr-4">Path</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="pl-4">
                        <Badge variant="secondary">{s.language}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{s.forced ? 'Yes' : '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{s.sdh ? 'Yes' : '—'}</TableCell>
                      <TableCell className="pr-4">
                        <p className="truncate font-mono text-xs text-muted-foreground">{s.path}</p>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rename (preview for this item)
// ---------------------------------------------------------------------------

function RenameTab({ item }: { item: MediaItemDetail }) {
  const toast = useToast();
  const lib = item.library;

  const preview = useMutation({
    mutationFn: () => {
      if (!lib) throw new ApiError(400, 'This item has no library configured.');
      return api.media.preview({
        path: item.path,
        preset: lib.preset,
        mode: lib.mode,
        libraryPath: lib.path,
        template: lib.template ?? undefined,
      });
    },
    onError: (err) => toast.error('Preview failed', err instanceof ApiError ? err.message : undefined),
  });

  const plan = preview.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Preview how this item would be renamed using its library’s preset and template.
          </p>
          <Button variant="secondary" onClick={() => preview.mutate()} loading={preview.isPending} disabled={!lib}>
            <RotateCw className="h-4 w-4" /> Preview rename
          </Button>
        </CardContent>
      </Card>

      {!lib && (
        <p className="text-sm text-muted-foreground">This item is not associated with a library.</p>
      )}

      {plan && (
        <Card>
          <CardContent className="space-y-2 p-4">
            {plan.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No files to rename.</p>
            ) : (
              plan.items.map((it, i) => (
                <div key={i} className="rounded-md border border-border/60 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={it.skipped ? 'secondary' : 'success'}>{it.action}</Badge>
                    {it.reason && <span className="text-xs text-muted-foreground">{it.reason}</span>}
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{it.source}</p>
                  {it.destination && (
                    <p className="mt-0.5 break-all font-mono text-xs text-foreground/80">→ {it.destination}</p>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NFO
// ---------------------------------------------------------------------------

function NfoTab({ item }: { item: MediaItemDetail }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canGenerate = hasPermission(PERMISSIONS.MEDIA_MANAGER_GENERATE_NFO);

  const generate = useMutation({
    mutationFn: () => api.media.generateNfo(item.id),
    onSuccess: (res) => {
      toast.success('NFO generated', `${res.generated} file(s) written.`);
      queryClient.invalidateQueries({ queryKey: ['media', 'items', item.id] });
    },
    onError: (err) => toast.error('Could not generate NFO', err instanceof ApiError ? err.message : undefined),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Generate a Kodi-style .nfo sidecar for this item from its metadata.
          </p>
          {canGenerate && (
            <Button variant="secondary" onClick={() => generate.mutate()} loading={generate.isPending}>
              <FileText className="h-4 w-4" /> Generate NFO
            </Button>
          )}
        </CardContent>
      </Card>

      {item.nfoFiles.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<FileText className="h-6 w-6" />}
              title="No NFO files"
              description="No .nfo sidecar files have been generated for this item yet."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {item.nfoFiles.map((n) => (
            <Card key={n.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
                <div className="min-w-0">
                  <Badge variant="outline">{n.type}</Badge>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{n.path}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History (recent rename operations, filtered to this item's paths)
// ---------------------------------------------------------------------------

function ItemHistoryTab({ item }: { item: MediaItemDetail }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'history'],
    queryFn: api.media.history,
  });

  if (isLoading) return <CenteredSpinner label="Loading history…" />;
  if (isError) return <ErrorState message="Could not load history." onRetry={() => refetch()} />;

  const filePaths = new Set(item.files.map((f) => f.path));
  const related = (data ?? []).filter(
    (op) =>
      op.source === item.path ||
      op.source.startsWith(item.path) ||
      filePaths.has(op.source),
  );
  const rows = related.length > 0 ? related : (data ?? []).slice(0, 20);

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title="No history"
            description="Applied rename operations are recorded here."
          />
        </CardContent>
      </Card>
    );
  }

  const tone = (status: string) =>
    status === 'success' || status === 'applied'
      ? 'success'
      : status === 'failed'
        ? 'destructive'
        : 'secondary';

  return (
    <div className="space-y-2">
      {related.length === 0 && (
        <p className="text-xs text-muted-foreground">No operations matched this item — showing recent activity.</p>
      )}
      {rows.map((op) => (
        <Card key={op.id}>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={tone(op.status)} dot>
                {op.status}
              </Badge>
              <Badge variant="outline">{op.action}</Badge>
            </div>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{op.source}</p>
            {op.destination && (
              <p className="mt-0.5 break-all font-mono text-xs text-foreground/80">→ {op.destination}</p>
            )}
            {op.message && <p className="mt-1 text-xs text-muted-foreground">{op.message}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
