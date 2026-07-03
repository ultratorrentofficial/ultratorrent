import { useNavigate } from 'react-router-dom';
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
  const { data, isLoading, isError } = useVersion();
  const year = new Date().getFullYear();
  const edition = data?.edition ? data.edition[0].toUpperCase() + data.edition.slice(1) : '—';

  return (
    <Dialog open={open} onClose={onClose} title="About UltraTorrent" className="max-w-md">
      <DialogHeader>
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="" className="h-8 w-auto object-contain" />
        </div>
        <DialogTitle className="mt-2">{data?.product ?? 'UltraTorrent'}</DialogTitle>
        <DialogDescription>
          Enterprise torrent management platform.
        </DialogDescription>
      </DialogHeader>

      <div className="divide-y divide-border/50 rounded-lg border border-border/60 bg-white/[0.02] px-4">
        <Row
          label="Version"
          value={
            isLoading ? '…' : isError ? 'unavailable' : `v${data?.version ?? '—'}`
          }
        />
        <Row label="Edition" value={isLoading ? '…' : edition} />
        <Row label="API" value={data?.apiVersion ?? '—'} />
        <Row
          label="Build"
          value={data?.buildTime ? formatDateTime(data.buildTime) : 'dev'}
        />
        {data?.gitSha ? <Row label="Commit" value={data.gitSha.slice(0, 10)} /> : null}
        <Row label="Runtime" value={data?.node ?? '—'} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          © {year} UltraTorrent. Licensed software.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onClose();
            navigate('/license');
          }}
        >
          <KeyRound className="mr-1.5 h-3.5 w-3.5" />
          License
          <ExternalLink className="ml-1.5 h-3 w-3 opacity-60" />
        </Button>
      </div>
    </Dialog>
  );
}
