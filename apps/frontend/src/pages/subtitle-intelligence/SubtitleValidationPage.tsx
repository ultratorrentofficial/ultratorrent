import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { api, type SubtitleValidationResult } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/input';

export function SubtitleValidationPage() {
  const { t } = useTranslation('subtitleIntelligence');
  const toast = useToast();
  const [text, setText] = useState('');
  const [result, setResult] = useState<SubtitleValidationResult | null>(null);

  const validate = useMutation({
    mutationFn: () => api.subtitles.validate({ content: text }),
    onSuccess: setResult,
    onError: (e) => toast.error(t('common.error'), (e as Error).message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShieldAlert className="h-6 w-6 text-primary" /> {t('validation.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('validation.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <Label htmlFor="sub-text">{t('validation.paste')}</Label>
          <textarea
            id="sub-text"
            className="h-56 w-full rounded-md border border-border bg-transparent p-3 font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'1\n00:00:01,000 --> 00:00:04,000\nHello world.'}
          />
          <Button onClick={() => validate.mutate()} loading={validate.isPending} disabled={!text.trim()}>
            {t('validation.run')}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={result.valid ? 'success' : 'destructive'}>
                {result.valid ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <ShieldAlert className="mr-1 h-3 w-3" />}
                {result.valid ? t('validation.valid') : t('validation.invalid')}
              </Badge>
              <Badge variant="secondary">{result.format.toUpperCase()}</Badge>
              <Badge variant="outline">{t('validation.cues', { n: result.cueCount })}</Badge>
            </div>
            {result.issues.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('validation.noIssues')}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {result.issues.map((iss, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Badge variant={iss.severity === 'error' ? 'destructive' : 'warning'}>{iss.severity}</Badge>
                    <span>{iss.message}{iss.cue ? ` (cue ${iss.cue})` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
