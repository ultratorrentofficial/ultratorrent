import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Captions, Music, TriangleAlert } from 'lucide-react';
import { isReliablyPlayable, type FileNode } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { matchSubtitlesFor, parseSubtitles, subtitleLanguageTag, toVtt } from '@/lib/subtitles';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Play a video or audio file straight out of the file manager.
 *
 * Two things make this more than an `<video src>`:
 *
 *  - **Subtitles.** A film in a download directory almost always has its SRT
 *    lying next to it, and `<track>` accepts only WebVTT. The sibling is fetched,
 *    parsed and converted in the browser, so the subtitle someone downloaded is
 *    usable without converting anything on disk.
 *  - **An honest failure.** Browsers decode a narrow set of containers, and MKV
 *    is not reliably one of them. A player that shows a black rectangle with no
 *    explanation reads as a broken app; this says what happened and offers the
 *    download instead.
 */
export function MediaPlayer({
  url,
  node,
  siblings,
  kind,
  onDownload,
}: {
  url: string;
  node: FileNode;
  siblings: FileNode[];
  kind: 'video' | 'audio';
  onDownload?: () => void;
}) {
  const { t } = useTranslation('files');
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [subtitlePath, setSubtitlePath] = useState<string>('');

  useEffect(() => { setFailed(false); setSubtitlePath(''); setSpeed(1); }, [url]);
  useEffect(() => { if (mediaRef.current) mediaRef.current.playbackRate = speed; }, [speed]);

  /** Subtitles that belong to THIS file — not every subtitle in the folder. */
  const subtitleOptions = useMemo(() => {
    const names = siblings.filter((s) => !s.isDirectory).map((s) => s.name);
    return matchSubtitlesFor(node.name, names)
      .map((name) => siblings.find((s) => s.name === name))
      .filter((s): s is FileNode => !!s);
  }, [siblings, node.name]);

  // The chosen subtitle's text, fetched through the ordinary preview route (it
  // returns decoded text, so a Latin-1 subtitle arrives already readable).
  const { data: subtitleText } = useQuery({
    queryKey: ['file-subtitle-text', subtitlePath],
    queryFn: () => api.files.preview(subtitlePath),
    enabled: !!subtitlePath,
    retry: false,
  });

  /*
   * `<track>` needs a URL, so the converted VTT becomes a blob. Revoked when it
   * is replaced or the player closes — a blob URL is a document-lifetime leak
   * otherwise, and this component churns them as someone pages through a folder.
   */
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!subtitleText?.content) { setTrackUrl(null); return; }
    const vtt = toVtt(parseSubtitles(subtitleText.content));
    const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    setTrackUrl(blobUrl);
    return () => URL.revokeObjectURL(blobUrl);
  }, [subtitleText?.content]);

  const risky = !isReliablyPlayable(node.name);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border/60 bg-black/20 p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-warning" />
        <div>
          <p className="text-sm font-medium">{t('preview.playbackFailed')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('preview.playbackFailedHint')}</p>
        </div>
        {onDownload && <Button variant="secondary" onClick={onDownload}>{t('preview.download')}</Button>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {risky && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>{t('preview.containerWarning', { extension: node.name.split('.').pop()?.toUpperCase() ?? '' })}</span>
        </div>
      )}

      {kind === 'video' ? (
        <video
          ref={mediaRef}
          key={url}
          src={url}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          className="max-h-[58vh] w-full rounded-lg bg-black"
        >
          {trackUrl && (
            <track
              // Remounting on the source path is what makes the browser load the
              // new cues; swapping `src` on a live track element does not.
              key={subtitlePath}
              kind="subtitles"
              src={trackUrl}
              srcLang={subtitleLanguageTag(subtitlePath.split('/').pop() ?? '') ?? 'und'}
              label={subtitlePath.split('/').pop() ?? ''}
              default
            />
          )}
        </video>
      ) : (
        <div className="space-y-4 rounded-lg border border-border/60 bg-black/20 p-6">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Music className="h-6 w-6" />
            </div>
            <p className="min-w-0 truncate text-sm font-medium">{node.name}</p>
          </div>
          <audio
            ref={mediaRef}
            key={url}
            src={url}
            controls
            preload="metadata"
            onError={() => setFailed(true)}
            className="w-full"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('preview.speed')}
          <Select
            className="h-8 w-24 text-xs"
            value={String(speed)}
            onChange={(e) => setSpeed(Number(e.target.value))}
            options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
            aria-label={t('preview.speed')}
          />
        </label>

        {kind === 'video' && subtitleOptions.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Captions className="h-3.5 w-3.5" />
            <Select
              className="h-8 w-56 text-xs"
              value={subtitlePath}
              onChange={(e) => setSubtitlePath(e.target.value)}
              aria-label={t('preview.subtitleTrack')}
            >
              <option value="">{t('preview.subtitleNone')}</option>
              {subtitleOptions.map((s) => (
                <option key={s.path} value={s.path}>{s.name}</option>
              ))}
            </Select>
          </label>
        )}
      </div>
    </div>
  );
}
