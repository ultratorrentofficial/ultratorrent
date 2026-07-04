import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, CheckCircle2, Copy, KeyRound, ExternalLink, RefreshCw } from 'lucide-react';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ApiError, api } from '@/lib/api';
import { useVersion } from '@/hooks/useVersion';
import { formatDateTime, formatRelativeTime } from '@/lib/format';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-right text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

/**
 * "About UltraTorrent" — platform identity, version, build, and environment,
 * sourced from `GET /api/system/version` (never hardcoded). Opened from the
 * sidebar version badge and the user menu.
 */
/** Update-availability panel — sourced from `GET /api/system/update`. */
function UpdateSection() {
  const { t } = useTranslation('shell');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.SYSTEM_MANAGE);

  const { data, isLoading } = useQuery({
    queryKey: ['system', 'update'],
    queryFn: api.system.update,
  });

  const check = useMutation({
    mutationFn: () => api.system.checkUpdate(),
    onSuccess: (s) => {
      queryClient.setQueryData(['system', 'update'], s);
      if (!s.updateAvailable && !s.error) toast.success(t('about.update.upToDate'));
    },
    onError: (e) => toast.error(t('about.update.checkFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.system.setUpdateCheck(enabled),
    onSuccess: (s) => queryClient.setQueryData(['system', 'update'], s),
    onError: (e) => toast.error(t('about.update.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const copySteps = () => {
    void navigator.clipboard?.writeText(data?.updateSteps.join('\n') ?? '');
    toast.success(t('about.update.copied'));
  };

  const headline = isLoading
    ? t('about.update.checking')
    : data?.updateAvailable
      ? t('about.update.available', { version: data.latest })
      : data?.error
        ? t('about.update.unavailable')
        : t('about.update.current');

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border/60 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {data?.updateAvailable ? (
            <ArrowUpCircle className="h-4 w-4 text-primary" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-success" />
          )}
          <span className="text-sm font-medium">{headline}</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => check.mutate()} loading={check.isPending}>
          <RefreshCw className="h-3.5 w-3.5" /> {t('about.update.checkNow')}
        </Button>
      </div>

      {data?.updateAvailable && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">{t(`about.update.deployment.${data.deployment}`)}</Badge>
            {data.changelogUrl && (
              <a
                href={data.changelogUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {t('about.update.releaseNotes')}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div className="rounded-md border border-border/60 bg-black/30 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t('about.update.howTo')}
              </span>
              <button
                type="button"
                onClick={copySteps}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
              >
                <Copy className="h-3 w-3" /> {t('about.update.copy')}
              </button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground/90">
              {data.updateSteps.join('\n')}
            </pre>
          </div>
        </div>
      )}

      {data?.checkedAt && (
        <p className="text-[11px] text-muted-foreground">
          {t('about.update.lastChecked', { time: formatRelativeTime(data.checkedAt) })}
        </p>
      )}

      {canManage && data && (
        <div className="flex items-center justify-between border-t border-border/60 pt-3">
          <span className="text-xs text-muted-foreground">{t('about.update.autoCheck')}</span>
          <Switch checked={data.checkEnabled} onCheckedChange={(v) => toggle.mutate(v)} />
        </div>
      )}
    </div>
  );
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { t } = useTranslation('shell');
  const { hasPermission } = useAuth();
  const { data, isLoading, isError } = useVersion();
  const year = new Date().getFullYear();
  const edition = data?.edition ? data.edition[0].toUpperCase() + data.edition.slice(1) : '—';
  const canViewSystem = hasPermission(PERMISSIONS.SYSTEM_VIEW);

  return (
    <Dialog open={open} onClose={onClose} title={t('about.title')} className="max-w-md">
      <DialogHeader>
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="" className="h-8 w-auto object-contain" />
        </div>
        <DialogTitle className="mt-2">{data?.product ?? 'UltraTorrent'}</DialogTitle>
        <DialogDescription>{t('about.tagline')}</DialogDescription>
      </DialogHeader>

      <div className="divide-y divide-border/50 rounded-lg border border-border/60 bg-white/[0.02] px-4">
        <Row
          label={t('about.version')}
          value={
            isLoading ? '…' : isError ? t('about.unavailable') : `v${data?.version ?? '—'}`
          }
        />
        <Row
          label={t('about.tag')}
          value={isLoading ? '…' : isError ? t('about.unavailable') : data?.gitTag ?? '—'}
        />
        <Row label={t('about.edition')} value={isLoading ? '…' : edition} />
        <Row label={t('about.api')} value={data?.apiVersion ?? '—'} />
        <Row
          label={t('about.build')}
          value={data?.buildTime ? formatDateTime(data.buildTime) : t('about.dev')}
        />
        {data?.gitSha ? <Row label={t('about.commit')} value={data.gitSha.slice(0, 10)} /> : null}
        <Row label={t('about.runtime')} value={data?.node ?? '—'} />
      </div>

      {canViewSystem && <UpdateSection />}

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t('about.copyright', { year })}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onClose();
            navigate('/license');
          }}
        >
          <KeyRound className="mr-1.5 h-3.5 w-3.5" />
          {t('about.license')}
          <ExternalLink className="ml-1.5 h-3 w-3 opacity-60" />
        </Button>
      </div>
    </Dialog>
  );
}
