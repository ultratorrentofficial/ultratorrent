import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FlaskConical, History, ListChecks, PlayCircle } from 'lucide-react';
import {
  ApiError,
  api,
  type HistoryTestResultItem,
  type PreferenceListResultItem,
  type RssRuleMatchCandidate,
  type TestMatchResultItem,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import {
  CandidateResultBadge,
  CheckList,
  ParsedDebug,
  resultLabel,
} from './shared';

const SAMPLE =
  'Show.Name.S01E01.1080p.WEB-DL.x265-GROUP\nShow.Name.S01E02.720p.HDTV.x264-OTHER\nMovie.Title.2024.2160p.BluRay.x265-UHD';

export function TestingPanel({
  ruleId,
  candidates,
}: {
  ruleId: string;
  candidates: RssRuleMatchCandidate[];
}) {
  const { t } = useTranslation('rss');
  const toast = useToast();
  const [titlesText, setTitlesText] = useState('');
  const [candidateId, setCandidateId] = useState(candidates[0]?.id ?? '');
  const [running, setRunning] = useState<'candidate' | 'preference' | 'history' | null>(null);
  const [matchResults, setMatchResults] = useState<TestMatchResultItem[] | null>(null);
  const [prefResults, setPrefResults] = useState<PreferenceListResultItem[] | null>(null);
  const [historyResults, setHistoryResults] = useState<HistoryTestResultItem[] | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [grabbed, setGrabbed] = useState<Record<string, boolean>>({});

  const titles = (): string[] =>
    titlesText
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);

  const clearResults = () => {
    setMatchResults(null);
    setPrefResults(null);
    setHistoryResults(null);
  };

  // Primary path: evaluate the whole preference list against what the feed has
  // actually delivered (the stored history). Each matched row is grabbable.
  const runHistory = async () => {
    setRunning('history');
    try {
      const res = await api.rss.testAgainstHistory(ruleId);
      if (res.historyCount === 0) {
        clearResults();
        toast.info(
          t('testing.toast.noHistoryTitle'),
          t('testing.toast.noHistoryBody'),
        );
        return;
      }
      clearResults();
      setHistoryResults(res.results);
    } catch (err) {
      toast.error(t('testing.toast.testFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setRunning(null);
    }
  };

  // Actually grab a matched history item (real download, with real feedback).
  const downloadItem = async (historyId: string, title: string) => {
    setDownloadingId(historyId);
    try {
      await api.rss.downloadHistoryItem(historyId);
      setGrabbed((g) => ({ ...g, [historyId]: true }));
      toast.success(t('testing.toast.downloadStarted'), title);
    } catch (err) {
      toast.error(t('testing.toast.downloadFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setDownloadingId(null);
    }
  };

  const runCandidate = async () => {
    const titleList = titles();
    if (titleList.length === 0) {
      toast.error(t('testing.toast.noTitles'), t('testing.toast.noTitlesBody'));
      return;
    }
    if (!candidateId) {
      toast.error(t('testing.toast.noCandidateSelected'));
      return;
    }
    setRunning('candidate');
    try {
      const res = await api.rss.testMatch(ruleId, { candidateId, titles: titleList });
      clearResults();
      setMatchResults(res.results);
    } catch (err) {
      toast.error(t('testing.toast.testFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setRunning(null);
    }
  };

  const runPreference = async () => {
    const titleList = titles();
    if (titleList.length === 0) {
      toast.error(t('testing.toast.noTitles'), t('testing.toast.noTitlesBody'));
      return;
    }
    setRunning('preference');
    try {
      const res = await api.rss.testPreferenceList(ruleId, { titles: titleList });
      clearResults();
      setPrefResults(res.results);
    } catch (err) {
      toast.error(t('testing.toast.testFailed'), err instanceof ApiError ? err.message : undefined);
    } finally {
      setRunning(null);
    }
  };

  const noResults = !matchResults && !prefResults && !historyResults;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{t('testing.historyTitle')}</p>
              <p className="text-xs text-muted-foreground">
                {t('testing.historyDescription')}
              </p>
            </div>
            <Button onClick={runHistory} loading={running === 'history'}>
              <History className="h-4 w-4" /> {t('testing.testAgainstHistory')}
            </Button>
          </div>

          <div className="border-t border-border/60 pt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="test-titles">{t('testing.orTestLabel')}</Label>
              <Button variant="ghost" size="sm" onClick={() => setTitlesText(SAMPLE)}>
                {t('testing.insertSample')}
              </Button>
            </div>
            <Textarea
              id="test-titles"
              value={titlesText}
              onChange={(e) => setTitlesText(e.target.value)}
              placeholder={SAMPLE}
              className="min-h-[120px] font-mono text-xs"
            />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <Label htmlFor="test-candidate">{t('testing.candidateLabel')}</Label>
              <Select
                id="test-candidate"
                value={candidateId}
                onChange={(e) => setCandidateId(e.target.value)}
                disabled={candidates.length === 0}
                options={candidates.map((c, i) => ({
                  value: c.id,
                  label: `${i + 1}. ${c.name}`,
                }))}
              />
            </div>
            <Button
              variant="secondary"
              onClick={runCandidate}
              loading={running === 'candidate'}
              disabled={candidates.length === 0}
            >
              <PlayCircle className="h-4 w-4" /> {t('testing.testSelectedCandidate')}
            </Button>
            <Button
              variant="secondary"
              onClick={runPreference}
              loading={running === 'preference'}
            >
              <ListChecks className="h-4 w-4" /> {t('testing.testPreferenceList')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {matchResults && <CandidateResults results={matchResults} />}
      {prefResults && <PreferenceResults results={prefResults} />}
      {historyResults && (
        <HistoryResults
          results={historyResults}
          downloadingId={downloadingId}
          grabbed={grabbed}
          onDownload={downloadItem}
        />
      )}
      {noResults && (
        <Card>
          <CardContent>
            <EmptyState
              icon={<FlaskConical className="h-6 w-6" />}
              title={t('testing.emptyTitle')}
              description={t('testing.emptyDescription')}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CandidateResults({ results }: { results: TestMatchResultItem[] }) {
  const { t } = useTranslation('rss');
  // Matches first, then the rest (stable — original order preserved within each).
  const sorted = [...results].sort(
    (a, b) => (a.result === 'matched' ? 0 : 1) - (b.result === 'matched' ? 0 : 1),
  );
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-semibold">{t('testing.candidateResultsTitle')}</p>
        {sorted.map((r, i) => (
          <div key={`${r.title}-${i}`} className="rounded-md border border-border/60 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 break-all font-mono text-xs text-foreground/80">{r.title}</p>
              <CandidateResultBadge result={r.result} />
            </div>
            {r.reason && <p className="mt-1.5 text-sm text-muted-foreground">{r.reason}</p>}
            <CheckList checks={r.checks} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PreferenceResults({ results }: { results: PreferenceListResultItem[] }) {
  const { t } = useTranslation('rss');
  const sorted = sortMatchesFirst(results);
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <p className="text-sm font-semibold">{t('testing.preferenceResultsTitle')}</p>
        {sorted.map((r, i) => (
          <PreferenceRow key={`${r.title}-${i}`} item={r} />
        ))}
      </CardContent>
    </Card>
  );
}

/** Matches (action === 'download') first; stable within each group. */
function sortMatchesFirst<T extends { action: 'download' | 'none' }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => (a.action === 'download' ? 0 : 1) - (b.action === 'download' ? 0 : 1),
  );
}

function HistoryResults({
  results,
  downloadingId,
  grabbed,
  onDownload,
}: {
  results: HistoryTestResultItem[];
  downloadingId: string | null;
  grabbed: Record<string, boolean>;
  onDownload: (historyId: string, title: string) => void;
}) {
  const { t } = useTranslation('rss');
  const matches = results.filter((r) => r.action === 'download').length;
  const sorted = sortMatchesFirst(results);
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">{t('testing.historyResultsTitle')}</p>
          <Badge variant={matches > 0 ? 'success' : 'secondary'} dot>
            {t('testing.matchesBadge', { matches, total: results.length })}
          </Badge>
        </div>
        {sorted.map((r, i) => (
          <PreferenceRow
            key={`${r.historyId}-${i}`}
            item={r}
            download={{
              downloaded: r.downloaded || !!grabbed[r.historyId],
              hasMagnet: r.hasMagnet,
              loading: downloadingId === r.historyId,
              onDownload: () => onDownload(r.historyId, r.title),
            }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

interface DownloadControl {
  downloaded: boolean;
  hasMagnet: boolean;
  loading: boolean;
  onDownload: () => void;
}

export function PreferenceRow({
  item,
  download,
}: {
  item: PreferenceListResultItem;
  download?: DownloadControl;
}) {
  const { t } = useTranslation('rss');
  const matchedIndex = item.candidates.findIndex((c) => c.result === 'matched');
  const skipped = item.candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.result === 'skipped');
  const isMatch = item.action === 'download';

  // The action line means different things in the two modes: a manual title
  // test is a prediction ("would download"); a history row is actionable.
  const actionText = !isMatch
    ? t('testing.action.noMatch')
    : download
      ? download.downloaded
        ? t('testing.action.downloaded')
        : download.hasMagnet
          ? t('testing.action.clickToGrab')
          : t('testing.action.noMagnet')
      : t('testing.action.wouldDownload');

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-all font-mono text-xs text-foreground/80">{item.title}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={isMatch ? 'success' : 'secondary'} dot>
            {isMatch ? t('testing.match') : t('testing.noMatch')}
          </Badge>
          {download && isMatch && (
            download.downloaded ? (
              <Badge variant="success" dot>{t('testing.downloaded')}</Badge>
            ) : download.hasMagnet ? (
              <Button
                size="sm"
                variant="secondary"
                className="whitespace-nowrap"
                loading={download.loading}
                onClick={download.onDownload}
              >
                <Download className="h-4 w-4" /> {t('testing.download')}
              </Button>
            ) : null
          )}
        </div>
      </div>

      <ol className="mt-3 space-y-1.5">
        {item.candidates.map((c, i) => {
          const isMatched = i === matchedIndex;
          return (
            <li
              key={c.candidateId}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-sm',
                isMatched ? 'bg-success/10 ring-1 ring-success/30' : 'bg-white/[0.02]',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium">{t('testing.candidateN', { n: i + 1 })}</span>
                <span
                  className={cn(
                    'font-semibold',
                    c.result === 'matched' && 'text-success',
                    c.result === 'failed' && 'text-destructive',
                    c.result === 'disabled' && 'text-warning',
                    c.result === 'skipped' && 'text-muted-foreground',
                  )}
                >
                  {resultLabel(t, c.result)}
                </span>
                {c.reason && <span className="text-muted-foreground">— {c.reason}</span>}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-3 space-y-1 text-sm">
        <p className={cn('font-medium', isMatch ? 'text-success' : 'text-muted-foreground')}>
          {actionText}
        </p>
        {matchedIndex >= 0 && skipped.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('testing.skippedNote', {
              count: skipped.length,
              list: skipped.map(({ i }) => i + 1).join(` ${t('testing.and')} `),
              matched: matchedIndex + 1,
            })}
          </p>
        )}
      </div>

      <div className="mt-3">
        <ParsedDebug parsed={item.parsed} />
      </div>
    </div>
  );
}
