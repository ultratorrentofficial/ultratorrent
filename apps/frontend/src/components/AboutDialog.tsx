import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, ExternalLink } from 'lucide-react';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useVersion } from '@/hooks/useVersion';
import { formatDateTime } from '@/lib/format';

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
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { t } = useTranslation('shell');
  const { data, isLoading, isError } = useVersion();
  const year = new Date().getFullYear();
  const edition = data?.edition ? data.edition[0].toUpperCase() + data.edition.slice(1) : '—';

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
        <Row label={t('about.edition')} value={isLoading ? '…' : edition} />
        <Row label={t('about.api')} value={data?.apiVersion ?? '—'} />
        <Row
          label={t('about.build')}
          value={data?.buildTime ? formatDateTime(data.buildTime) : t('about.dev')}
        />
        {data?.gitSha ? <Row label={t('about.commit')} value={data.gitSha.slice(0, 10)} /> : null}
        <Row label={t('about.runtime')} value={data?.node ?? '—'} />
      </div>

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
