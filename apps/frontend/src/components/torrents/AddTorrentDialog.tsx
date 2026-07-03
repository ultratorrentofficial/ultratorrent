import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, Link2, Magnet, UploadCloud, X } from 'lucide-react';
import { ApiError, api, type AddTorrentPayload } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { PathPicker } from '@/components/PathPicker';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/format';

type Source = 'magnet' | 'url' | 'file';

export interface AddTorrentDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AddTorrentDialog({ open, onClose }: AddTorrentDialogProps) {
  const toast = useToast();
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setMagnet('');
    setUrl('');
    setFile(null);
    setCategory('');
    setSavePath('');
    setTags('');
    setStartPaused(false);
    setSource('magnet');
  };

  const close = () => {
    reset();
    onClose();
  };

  const canSubmit =
    (source === 'magnet' && magnet.trim().length > 0) ||
    (source === 'url' && url.trim().length > 0) ||
    (source === 'file' && file != null);

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);

    const options: Pick<AddTorrentPayload, 'category' | 'savePath' | 'tags' | 'startPaused'> = {
      category: category.trim() || undefined,
      savePath: savePath.trim() || undefined,
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
      toast.success('Torrent added', 'It will appear in your list shortly.');
      await queryClient.invalidateQueries({ queryKey: ['torrents'] });
      close();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to add torrent.';
      toast.error('Could not add torrent', message);
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
    <Dialog open={open} onClose={close} title="Add torrent" className="max-w-xl">
      <DialogHeader>
        <DialogTitle>Add torrent</DialogTitle>
        <DialogDescription>Add via magnet link, remote URL, or a .torrent file.</DialogDescription>
      </DialogHeader>

      <Tabs value={source} onValueChange={(v) => setSource(v as Source)}>
        <TabsList className="w-full">
          <TabsTrigger value="magnet" className="flex-1">
            <Magnet className="h-4 w-4" /> Magnet
          </TabsTrigger>
          <TabsTrigger value="url" className="flex-1">
            <Link2 className="h-4 w-4" /> URL
          </TabsTrigger>
          <TabsTrigger value="file" className="flex-1">
            <FileUp className="h-4 w-4" /> File
          </TabsTrigger>
        </TabsList>

        <div className="mt-4">
          <TabsContent value="magnet">
            <div className="space-y-2">
              <Label htmlFor="magnet">Magnet link</Label>
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
              <Label htmlFor="url">Torrent URL</Label>
              <Input
                id="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/file.torrent"
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
                    aria-label="Remove file"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <UploadCloud className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">Drop a .torrent file here</p>
                  <p className="text-xs text-muted-foreground">or click to browse</p>
                </>
              )}
            </div>
          </TabsContent>
        </div>
      </Tabs>

      {/* Shared options */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="category">Category</Label>
          <Input
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="movies"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tags">Tags</Label>
          <Input
            id="tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="hd, 1080p"
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="savePath">Save path</Label>
          <PathPicker
            id="savePath"
            value={savePath}
            onChange={setSavePath}
            placeholder="/downloads"
            aria-label="Save path"
            pickerTitle="Choose a save folder"
          />
        </div>
      </div>

      <label className="mt-4 flex items-center justify-between rounded-lg border border-border/60 bg-white/[0.02] px-3 py-2.5">
        <span className="text-sm font-medium">Add in paused state</span>
        <Switch checked={startPaused} onCheckedChange={setStartPaused} aria-label="Start paused" />
      </label>

      <DialogFooter>
        <Button variant="ghost" onClick={close} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
          Add torrent
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
