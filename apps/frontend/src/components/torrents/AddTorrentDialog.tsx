import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileUp, Link2, Magnet, UploadCloud, X } from 'lucide-react';
import { ApiError, api, type AddTorrentPayload, type MediaLibrary } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { PathPicker } from '@/components/PathPicker';
import { useEnsureDirectory } from '@/components/path/EnsureDirectory';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/format';

type Source = 'magnet' | 'url' | 'file';

/**
 * Where the finished download goes.
 *
 * `standard` is what this dialog has always done: the engine writes to the save
 * path and nothing else happens. `intake` hands it to Media Intake instead —
 * staged under a storage profile, hardlinked into the library, torrent left
 * seeding.
 *
 * The choice has to be made HERE. Intake can only be started by provenance, and
 * a hand-added torrent has none unless it is recorded at the moment it is added.
 */
type Destination = 'standard' | 'intake';

/**
 * Is `candidate` inside `parent`?
 *
 * Compares on separator boundaries, so `/downloads/Movies HD` is not treated as
 * living inside `/downloads/Movies`. Trailing slashes are normalised because a
 * path picker and a stored library path disagree about them routinely.
 */
export function isWithin(candidate: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  const c = norm(candidate.trim());
  const p = norm(parent.trim());
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * The library that will reorganise anything saved at `savePath`, if there is one.
 *
 * This is the guardrail for the standard path. Saving a download inside a library
 * that auto-organizes means the post-download pipeline renames the video into
 * place and drops the torrent — and, because that rename only ever sees the one
 * file it was given, abandons the release's subtitles and junk in the old folder.
 * Nothing is blocked here: it is a legitimate thing to do deliberately, and a
 * warning that stops you is a warning you learn to route around.
 */
export function organizingLibraryFor(
  savePath: string,
  libraries: MediaLibrary[] | undefined,
): MediaLibrary | undefined {
  if (!savePath.trim() || !libraries?.length) return undefined;
  return libraries
    .filter((l) => l.autoOrganize && isWithin(savePath, l.path))
    // Deepest match wins: nested libraries would otherwise report the outermost.
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export interface AddTorrentDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AddTorrentDialog({ open, onClose }: AddTorrentDialogProps) {
  const { t } = useTranslation('torrents');
  const toast = useToast();
  const { ensure: ensureDirectory, dialog: ensureDirectoryDialog } = useEnsureDirectory();
  const queryClient = useQueryClient();

  const [source, setSource] = useState<Source>('magnet');
  const [magnet, setMagnet] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [category, setCategory] = useState('');
  const [savePath, setSavePath] = useState('');
  const [tags, setTags] = useState('');
  const [startPaused, setStartPaused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [destination, setDestination] = useState<Destination>('standard');
  const [intakeProfileId, setIntakeProfileId] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Both only matter while the dialog is open, and both are small and cacheable.
  const { data: profiles } = useQuery({
    queryKey: ['intake', 'profiles'],
    queryFn: () => api.intake.profiles(),
    enabled: open,
  });
  const { data: libraries } = useQuery({
    queryKey: ['media', 'libraries'],
    queryFn: () => api.media.libraries(),
    enabled: open,
  });

  const intakeProfiles = useMemo(
    () => (profiles ?? []).filter((p) => p.isEnabled),
    [profiles],
  );
  const selectedProfile = intakeProfiles.find((p) => p.id === intakeProfileId);
  // A profile has to exist before the mode can mean anything.
  const intakeAvailable = intakeProfiles.length > 0;
  const organizingLibrary = useMemo(
    () => (destination === 'standard' ? organizingLibraryFor(savePath, libraries) : undefined),
    [destination, savePath, libraries],
  );

  const reset = () => {
    setMagnet('');
    setUrl('');
    setFile(null);
    setCategory('');
    setSavePath('');
    setTags('');
    setStartPaused(false);
    setSource('magnet');
    setDestination('standard');
    setIntakeProfileId('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const hasSource =
    (source === 'magnet' && magnet.trim().length > 0) ||
    (source === 'url' && url.trim().length > 0) ||
    (source === 'file' && file != null);
  // Managed intake without a profile has nowhere to stage: refuse rather than
  // fall back to the standard path, which would silently be the opposite choice.
  const canSubmit = hasSource && (destination === 'standard' || Boolean(intakeProfileId));

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    const intake = destination === 'intake';
    // Validate the save path against the hard roots and offer to create it if
    // missing. Skipped for intake: the server sets the path from the profile.
    if (!intake && savePath.trim() && !(await ensureDirectory(savePath))) return;
    setSubmitting(true);

    const options: Pick<
      AddTorrentPayload,
      'category' | 'savePath' | 'tags' | 'startPaused' | 'intakeProfileId'
    > = {
      category: category.trim() || undefined,
      // Never both: the server replaces the save path with the profile's staging
      // root, and sending a contradictory one invites a "why was it ignored".
      savePath: intake ? undefined : savePath.trim() || undefined,
      intakeProfileId: intake ? intakeProfileId : undefined,
      tags: tags.trim() ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      startPaused,
    };

    try {
      if (source === 'file' && file) {
        await api.torrents.upload(file, options);
      } else if (source === 'magnet') {
        await api.torrents.add({ magnet: magnet.trim(), ...options });
      } else {
        await api.torrents.add({ url: url.trim(), ...options });
      }
      toast.success(t('add.successTitle'), t('add.successBody'));
      await queryClient.invalidateQueries({ queryKey: ['torrents'] });
      close();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : t('add.errorFallback');
      toast.error(t('add.errorTitle'), message);
    } finally {
      setSubmitting(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      setFile(dropped);
      setSource('file');
    }
  };

  return (
    <>
    <Dialog open={open} onClose={close} title={t('add.title')} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('add.title')}</DialogTitle>
        <DialogDescription>{t('add.description')}</DialogDescription>
      </DialogHeader>

      <Tabs value={source} onValueChange={(v) => setSource(v as Source)}>
        <TabsList className="w-full">
          <TabsTrigger value="magnet" className="flex-1">
            <Magnet className="h-4 w-4" /> {t('add.tab.magnet')}
          </TabsTrigger>
          <TabsTrigger value="url" className="flex-1">
            <Link2 className="h-4 w-4" /> {t('add.tab.url')}
          </TabsTrigger>
          <TabsTrigger value="file" className="flex-1">
            <FileUp className="h-4 w-4" /> {t('add.tab.file')}
          </TabsTrigger>
        </TabsList>

        <div className="mt-4">
          <TabsContent value="magnet">
            <div className="space-y-2">
              <Label htmlFor="magnet">{t('add.magnetLabel')}</Label>
              <Input
                id="magnet"
                value={magnet}
                onChange={(e) => setMagnet(e.target.value)}
                placeholder="magnet:?xt=urn:btih:…"
                className="font-mono text-xs"
                autoFocus
              />
            </div>
          </TabsContent>

          <TabsContent value="url">
            <div className="space-y-2">
              <Label htmlFor="url">{t('add.urlLabel')}</Label>
              <Input
                id="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t('add.urlPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
          </TabsContent>

          <TabsContent value="file">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors',
                dragActive
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50 hover:bg-white/[0.02]',
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".torrent,application/x-bittorrent"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="flex items-center gap-3 rounded-md bg-white/5 px-3 py-2">
                  <FileUp className="h-4 w-4 text-primary" />
                  <div className="text-left">
                    <p className="text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                    aria-label={t('add.removeFile')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <UploadCloud className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">{t('add.dropHint')}</p>
                  <p className="text-xs text-muted-foreground">{t('add.browseHint')}</p>
                </>
              )}
            </div>
          </TabsContent>
        </div>
      </Tabs>

      {/* Destination — what happens to the files once the download finishes. */}
      <fieldset className="mt-5 space-y-2">
        <legend className="mb-2 text-sm font-medium">{t('add.destination.label')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['standard', 'intake'] as const).map((mode) => {
            const disabled = mode === 'intake' && !intakeAvailable;
            return (
              <label
                key={mode}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                  destination === mode
                    ? 'border-primary bg-primary/5'
                    : 'border-border/60 bg-white/[0.02] hover:border-primary/40',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <input
                  type="radio"
                  name="destination"
                  value={mode}
                  checked={destination === mode}
                  disabled={disabled}
                  onChange={() => setDestination(mode)}
                  className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
                />
                <span>
                  <span className="block text-sm font-medium">{t(`add.destination.${mode}`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(
                      disabled
                        ? 'add.destination.intakeUnavailable'
                        : `add.destination.${mode}Hint`,
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Shared options */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="category">{t('add.category')}</Label>
          <Input
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={t('add.categoryPlaceholder')}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tags">{t('add.tags')}</Label>
          <Input
            id="tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('add.tagsPlaceholder')}
          />
        </div>
        {destination === 'intake' ? (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="intakeProfile">{t('add.intakeProfile')}</Label>
            <Select
              id="intakeProfile"
              value={intakeProfileId}
              onChange={(e) => setIntakeProfileId(e.target.value)}
              aria-label={t('add.intakeProfile')}
            >
              <option value="">{t('add.intakeProfilePlaceholder')}</option>
              {intakeProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {/* The save path is not editable here — showing where it will land is
                the honest substitute for a field the server overrides anyway. */}
            <p className="text-xs text-muted-foreground">
              {selectedProfile
                ? t('add.intakeStagingPreview', { path: selectedProfile.stagingRoot })
                : t('add.intakeStagingHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="savePath">{t('add.savePath')}</Label>
            <PathPicker
              id="savePath"
              value={savePath}
              onChange={setSavePath}
              placeholder={t('add.savePathPlaceholder')}
              aria-label={t('add.savePathAria')}
              pickerTitle={t('add.savePathPicker')}
            />
            {organizingLibrary && (
              <p
                role="status"
                className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>{t('add.libraryWarning', { library: organizingLibrary.name })}</span>
              </p>
            )}
          </div>
        )}
      </div>

      <label className="mt-4 flex items-center justify-between rounded-lg border border-border/60 bg-white/[0.02] px-3 py-2.5">
        <span className="text-sm font-medium">{t('add.startPaused')}</span>
        <Switch checked={startPaused} onCheckedChange={setStartPaused} aria-label={t('add.startPausedAria')} />
      </label>

      <DialogFooter>
        <Button variant="ghost" onClick={close} disabled={submitting}>
          {t('add.cancel')}
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
          {t('add.submit')}
        </Button>
      </DialogFooter>
    </Dialog>
    {ensureDirectoryDialog}
    </>
  );
}
