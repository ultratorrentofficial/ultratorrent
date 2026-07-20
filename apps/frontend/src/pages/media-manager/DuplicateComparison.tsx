import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { api, type MediaDuplicateCandidate } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { seasonEpisodeLabel } from './constants';

/** `3078` → `51m 18s`. Runtime is one of the few honest cross-release comparisons. */
function formatDuration(sec: number | null): string | null {
  if (sec == null || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

interface RowProps {
  label: string;
  values: Array<string | null>;
  /** Highlight when the candidates disagree — that is the whole point of the view. */
  compare?: boolean;
}

function Row({ label, values, compare = true }: RowProps) {
  const { t } = useTranslation('media');
  const shown = values.map((v) => v ?? '—');
  const differs = compare && new Set(shown).size > 1;
  return (
    <tr className={differs ? 'bg-warning/5' : undefined}>
      <th scope="row" className="py-1.5 pr-3 text-left align-top text-xs font-medium text-muted-foreground">
        {label}
      </th>
      {shown.map((v, i) => (
        <td
          key={i}
          className={`py-1.5 pr-4 align-top text-sm ${differs ? 'font-medium' : ''}`}
        >
          {v}
        </td>
      ))}
      <td className="w-0 py-1.5">
        {differs ? (
          <span className="sr-only">{t('duplicates.compare.differs')}</span>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Side-by-side comparison of every candidate in a group.
 *
 * Measured and parsed technical data are shown in SEPARATE sections, not interleaved.
 * The parsed values come from the filename and are null on the large majority of a
 * renamed library — the renamer strips those tokens — so showing them beside measured
 * values would fill the table with blanks that read as "we failed to read this file"
 * rather than "the name never claimed it". The section headings say which is which.
 */
export function DuplicateComparison({ groupId }: { groupId: string }) {
  const { t } = useTranslation('media');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['media', 'duplicates', 'detail', groupId],
    queryFn: () => api.media.duplicateGroup(groupId),
  });

  if (isLoading) return <CenteredSpinner />;
  if (isError || !data) {
    return <ErrorState title={t('duplicates.compare.loadError')} onRetry={() => void refetch()} />;
  }

  const c: MediaDuplicateCandidate[] = data.candidates;
  const keep = data.suggestedKeepId;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse">
          <thead>
            <tr>
              <th className="w-40" />
              {c.map((x) => (
                <th key={x.id} className="pb-2 pr-4 text-left align-bottom">
                  <div className="flex items-center gap-1.5">
                    {x.id === keep ? (
                      <Star className="h-4 w-4 shrink-0 text-warning" aria-label={t('duplicates.suggestedKeepAria')} />
                    ) : null}
                    <span className="truncate text-sm font-semibold">{x.libraryName ?? x.libraryId}</span>
                  </div>
                  <p className="mt-0.5 break-all font-mono text-[11px] leading-tight text-muted-foreground">
                    {x.path}
                  </p>
                </th>
              ))}
              <th className="w-0" />
            </tr>
          </thead>

          <tbody>
            <tr>
              <td colSpan={c.length + 2} className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('duplicates.compare.identity')}
              </td>
            </tr>
            <Row label={t('duplicates.compare.title')} values={c.map((x) => x.title)} />
            <Row label={t('duplicates.compare.year')} values={c.map((x) => (x.year != null ? String(x.year) : null))} />
            <Row
              label={t('duplicates.compare.episode')}
              values={c.map((x) => seasonEpisodeLabel(x.season, x.episode) || null)}
            />
            <Row label={t('duplicates.compare.matchStatus')} values={c.map((x) => x.matchStatus)} />
            <Row
              label={t('duplicates.compare.externalIds')}
              values={c.map((x) =>
                x.externalIds.length ? x.externalIds.map((e) => `${e.provider}:${e.externalId}`).join(', ') : null,
              )}
            />

            <tr>
              <td colSpan={c.length + 2} className="pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('duplicates.compare.measured')}
                <span className="ml-2 font-normal normal-case text-muted-foreground/80">
                  {t('duplicates.compare.measuredHint')}
                </span>
              </td>
            </tr>
            <Row label={t('duplicates.compare.size')} values={c.map((x) => formatBytes(x.totalSize))} />
            <Row
              label={t('duplicates.compare.dimensions')}
              values={c.map((x) => (x.measured.width && x.measured.height ? `${x.measured.width}×${x.measured.height}` : null))}
            />
            <Row
              label={t('duplicates.compare.bitrate')}
              values={c.map((x) => (x.measured.bitrateKbps ? `${x.measured.bitrateKbps} kbps` : null))}
            />
            <Row label={t('duplicates.compare.runtime')} values={c.map((x) => formatDuration(x.measured.durationSec))} />
            <Row
              label={t('duplicates.compare.audioChannels')}
              values={c.map((x) => (x.measured.audioChannels ? String(x.measured.audioChannels) : null))}
            />
            <Row
              label={t('duplicates.compare.frameRate')}
              values={c.map((x) => (x.measured.frameRate ? `${x.measured.frameRate} fps` : null))}
            />

            <tr>
              <td colSpan={c.length + 2} className="pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('duplicates.compare.parsed')}
                <span className="ml-2 font-normal normal-case text-muted-foreground/80">
                  {t('duplicates.compare.parsedHint')}
                </span>
              </td>
            </tr>
            <Row label={t('duplicates.compare.container')} values={c.map((x) => x.parsed.container)} />
            <Row label={t('duplicates.compare.resolution')} values={c.map((x) => x.parsed.resolution)} />
            <Row label={t('duplicates.compare.videoCodec')} values={c.map((x) => x.parsed.videoCodec)} />
            <Row label={t('duplicates.compare.audioCodec')} values={c.map((x) => x.parsed.audioCodec)} />
            <Row label={t('duplicates.compare.hdr')} values={c.map((x) => x.parsed.hdr)} />
            <Row label={t('duplicates.compare.releaseGroup')} values={c.map((x) => x.parsed.releaseGroup)} />
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Badge variant="secondary">{t('duplicates.compare.version', { version: data.version })}</Badge>
        {data.requiresReview ? (
          <Badge variant="destructive">{t('duplicates.badge.reviewRequired')}</Badge>
        ) : null}
        {/* Resolution is Phase 3. Rather than a button that does nothing, the view
            states plainly what it can and cannot do yet. */}
        <p className="text-xs text-muted-foreground">{t('duplicates.compare.noActionYet')}</p>
      </div>
    </div>
  );
}

/** Small helper so the card can offer "compare" without owning the query. */
export function CompareToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation('media');
  return (
    <Button variant="outline" size="sm" onClick={onToggle}>
      {open ? t('duplicates.compare.hide') : t('duplicates.compare.show')}
    </Button>
  );
}
