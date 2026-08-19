import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileQuestion, Info } from 'lucide-react';
import { filePreviewKind, isStreamableKind, type FileNode, type PreviewTextEncoding } from '@ultratorrent/shared';
import { ApiError, api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner } from '@/components/ui/feedback';
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ImageViewer } from './ImageViewer';
import { MediaPlayer } from './MediaPlayer';
import { SubtitleViewer } from './SubtitleViewer';
import { TextViewer } from './TextViewer';
import { useMediaUrl } from './useMediaUrl';

/**
 * The File Manager's preview surface.
 *
 * Replaces a dialog that did exactly one thing — read the file as UTF-8 and
 * print it in a `<pre>` — which meant clicking a JPEG produced mojibake and
 * clicking an MKV produced "File too large to preview". What is shown is now
 * decided by what the file *is*: images get a lightbox, media gets a player,
 * subtitles get their cues, NFOs get a correctly decoded fixed-width reader.
 *
 * Navigation between files is part of the point. Looking at screenshots or
 * checking which of four subtitle files is the right one means moving between
 * them, and closing and reopening a dialog for each is the wrong shape for that.
 */
export function PreviewModal({
  open,
  node,
  siblings,
  canDownload,
  onNavigate,
  onClose,
}: {
  open: boolean;
  node: FileNode | null;
  /** Everything in the current folder, for prev/next and subtitle matching. */
  siblings: FileNode[];
  canDownload: boolean;
  onNavigate: (node: FileNode) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('files');
  const toast = useToast();
  /** Caller-chosen decoding; cleared per file so detection gets first say. */
  const [encoding, setEncoding] = useState<PreviewTextEncoding | null>(null);
  useEffect(() => setEncoding(null), [node?.path]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['file-preview', node?.path, encoding],
    queryFn: () => api.files.preview(node!.path, encoding ?? undefined),
    enabled: open && !!node,
    retry: false,
  });

  const kind = data?.kind ?? (node ? filePreviewKind(node.name) : 'binary');
  /*
   * The ticket is requested from the name alone rather than after the preview
   * call answers. Both are round trips and neither depends on the other, so
   * waiting would open every image at twice the latency for no added certainty —
   * the name is what decides `streamable` on the server too.
   */
  const needsStream = open && !!node && isStreamableKind(filePreviewKind(node.name));
  const { url: streamUrl, isError: streamFailed } = useMediaUrl(node?.path, needsStream);

  /*
   * Only files that have something to show take part in prev/next. Stepping
   * through a folder should not stop on a ZIP to say it cannot be previewed —
   * the arrows are for moving between things worth looking at.
   */
  const previewable = useMemo(
    () => siblings.filter((s) => !s.isDirectory && !['archive', 'binary'].includes(filePreviewKind(s.name))),
    [siblings],
  );
  const position = node ? previewable.findIndex((s) => s.path === node.path) : -1;
  const previous = position > 0 ? previewable[position - 1] : null;
  const next = position >= 0 && position < previewable.length - 1 ? previewable[position + 1] : null;

  // Arrow keys page through the folder. Bound on window because focus may be
  // anywhere in the dialog — inside a search box, on a zoom button — and the
  // gesture should work regardless.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal the arrow keys from a field someone is typing in, or from a
      // media element where they mean "seek".
      if (target && /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(target.tagName)) return;
      if (e.key === 'ArrowLeft' && previous) onNavigate(previous);
      if (e.key === 'ArrowRight' && next) onNavigate(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, previous, next, onNavigate]);

  const download = async () => {
    if (!node) return;
    try {
      await api.files.download(node.path);
    } catch (err) {
      toast.error(t('toast.downloadFailed'), err instanceof ApiError ? err.message : undefined);
    }
  };

  if (!node) return null;

  const textProps = {
    content: data?.content ?? '',
    encoding: data?.encoding ?? null,
    detectedEncoding: data?.detectedEncoding ?? null,
    truncated: data?.truncated ?? false,
    onEncodingChange: setEncoding,
  };

  const body = () => {
    if (isLoading) return <CenteredSpinner label={t('preview.loading')} />;
    if (isError) {
      return (
        <Unavailable
          message={(error as ApiError)?.message ?? t('preview.cannotPreview')}
          action={canDownload ? { label: t('preview.download'), onClick: download } : undefined}
        />
      );
    }
    if (data?.reason) {
      return (
        <Unavailable
          message={data.reason}
          action={canDownload ? { label: t('preview.download'), onClick: download } : undefined}
        />
      );
    }

    if (data?.streamable) {
      if (streamFailed) return <Unavailable message={t('preview.ticketFailed')} />;
      if (!streamUrl) return <CenteredSpinner label={t('preview.loading')} />;
      if (kind === 'image') return <ImageViewer url={streamUrl} name={node.name} />;
      if (kind === 'video' || kind === 'audio') {
        return (
          <MediaPlayer
            url={streamUrl}
            node={node}
            siblings={siblings}
            kind={kind}
            onDownload={canDownload ? download : undefined}
          />
        );
      }
      if (kind === 'pdf') {
        return (
          <div className="space-y-2">
            {/* The stream route serves PDFs inline with `nosniff`, so the
                browser's own viewer renders it in place. */}
            <iframe src={streamUrl} title={node.name} className="h-[58vh] w-full rounded-lg border border-border/60 bg-white" />
            <a
              href={streamUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" /> {t('preview.openInTab')}
            </a>
          </div>
        );
      }
    }

    if (kind === 'subtitle') return <SubtitleViewer {...textProps} />;
    return <TextViewer {...textProps} />;
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('preview.titleBar')} className="max-w-5xl">
      <DialogHeader className="mb-3">
        <div className="flex items-center gap-2">
          <DialogTitle className="min-w-0 flex-1 truncate">{node.name}</DialogTitle>
          <Badge variant="outline" className="shrink-0">{t(`preview.kind.${kind}`)}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>{formatBytes(data?.size ?? node.size)}</span>
          {previewable.length > 1 && position >= 0 && (
            <span className="tabular-nums">{t('preview.position', { index: position + 1, total: previewable.length })}</span>
          )}
        </div>
      </DialogHeader>

      {body()}

      <DialogFooter className="flex-wrap">
        <div className="mr-auto flex items-center gap-1.5">
          <Button variant="subtle" size="icon" onClick={() => previous && onNavigate(previous)} disabled={!previous} aria-label={t('preview.previous')}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="subtle" size="icon" onClick={() => next && onNavigate(next)} disabled={!next} aria-label={t('preview.next')}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {canDownload && (
          <Button variant="secondary" onClick={download}>
            <Download className="h-4 w-4" /> {t('preview.download')}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>{t('preview.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Nothing to show, and why — with the download still on offer. */
function Unavailable({ message, action }: { message: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border/60 bg-black/20 p-8 text-center">
      <FileQuestion className="h-8 w-8 text-muted-foreground" />
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Info className="h-3.5 w-3.5" /> {message}
      </p>
      {action && <Button variant="secondary" onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}
