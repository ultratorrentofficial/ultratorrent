import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Play } from 'lucide-react';
import { api, ApiError, type SimulationResult, type SimulationStage } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const STATUS_DOT: Record<SimulationStage['status'], string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  blocked: 'bg-destructive',
  info: 'bg-muted-foreground',
};

const DECISION_VARIANT: Record<string, BadgeProps['variant']> = {
  download: 'success',
  upgrade_existing: 'success',
  replace_existing: 'success',
  wait: 'info',
  hold_for_approval: 'warning',
  manual_review: 'warning',
  skip: 'secondary',
};

export function DecisionSimulatorPage() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const [releaseName, setReleaseName] = useState('');
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const sim = useMutation({
    mutationFn: () => api.mediaAcquisition.simulate({ releaseName: releaseName.trim() }),
    onSuccess: (r) => {
      setResult(r);
      setOpen(null);
    },
    onError: (err) =>
      toast.error(
        t('acquisition.simulator.failed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (releaseName.trim()) sim.mutate();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('acquisition.simulator.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('acquisition.simulator.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="p-4">
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sim-release">{t('acquisition.simulator.releaseName')}</Label>
              <Input
                id="sim-release"
                value={releaseName}
                onChange={(e) => setReleaseName(e.target.value)}
                placeholder="The Show S01E02 2160p BluRay DV TrueHD Atmos x265-GRP"
                autoFocus
              />
            </div>
            <Button type="submit" disabled={!releaseName.trim() || sim.isPending}>
              <Play className="h-4 w-4" />
              {sim.isPending ? t('acquisition.simulator.running') : t('acquisition.simulator.run')}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <div className="space-y-4">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant={DECISION_VARIANT[result.decision] ?? 'secondary'}>
                    {t(`acquisition.simulator.decision.${result.decision}`, { defaultValue: result.decision })}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {t('acquisition.simulator.confidence', { n: result.confidence })}
                  </span>
                </div>
                <p className="mt-1 text-sm text-foreground/90">{result.reason}</p>
              </div>
              {result.profile && (
                <span className="text-xs text-muted-foreground">
                  {t('acquisition.simulator.profile', { name: result.profile.name })}
                </span>
              )}
            </CardContent>
          </Card>

          {/* Visual pipeline — each stage is clickable to reveal its detail. */}
          <ol className="space-y-2">
            {result.stages.map((stage, i) => {
              const expanded = open === stage.key;
              return (
                <li key={stage.key}>
                  <Card>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 p-3 text-left"
                      onClick={() => setOpen(expanded ? null : stage.key)}
                    >
                      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', STATUS_DOT[stage.status])} />
                      <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                      <span className="shrink-0 font-medium">{stage.label}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{stage.summary}</span>
                      {expanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                    {expanded && stage.detail && (
                      <div className="border-t border-white/5 px-3 py-2">
                        <pre className="overflow-x-auto text-xs text-muted-foreground">
                          {JSON.stringify(stage.detail, null, 2)}
                        </pre>
                      </div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
