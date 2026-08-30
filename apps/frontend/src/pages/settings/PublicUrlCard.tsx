import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Globe, Minus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api, ApiError, type PublicUrlStatus, type PublicUrlVerdict } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Badge, type BadgeVariant } from '@/components/ui/badge';

/**
 * Settings → Public URL. The one address that is true from outside the network,
 * and therefore the only one safe to put in a link somebody else will open.
 *
 * The checks are RENDERED FROM A LIVE PROBE rather than from stored state. DNS,
 * a port forward and a certificate all change outside this application, so a
 * remembered answer would be confidently wrong at exactly the moment an operator
 * opens this card to find out what broke.
 *
 * Certificates are reported, not issued — see PublicUrlService for why the app
 * cannot honestly obtain one from inside its container.
 */

const VERDICT_VARIANT: Record<PublicUrlVerdict, BadgeVariant> = {
  ok: 'success',
  expiring: 'warning',
  untrusted: 'destructive',
  insecure: 'warning',
  unreachable: 'destructive',
  unset: 'secondary',
};

/** Three states, because "not applicable" is not the same as "failing". */
type CheckState = 'pass' | 'fail' | 'na';

function CheckRow({ state, label, detail }: { state: CheckState; label: string; detail?: string | null }) {
  const Icon = state === 'pass' ? Check : state === 'fail' ? X : Minus;
  const tone =
    state === 'pass' ? 'text-success' : state === 'fail' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden />
      <span className="flex-1">
        {label}
        {detail ? <span className="ml-2 text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </li>
  );
}

export function PublicUrlCard() {
  const { t } = useTranslation('settings');
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canManage = hasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const q = useQuery({ queryKey: ['system', 'public-url'], queryFn: () => api.system.publicUrl() });

  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<PublicUrlStatus | null>(null);

  useEffect(() => {
    if (q.data) setUrl(q.data.url);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.system.setPublicUrl(url),
    onSuccess: (res) => {
      setUrl(res.url);
      toast.success(t('publicUrl.saved'));
      queryClient.invalidateQueries({ queryKey: ['system', 'public-url'] });
      // Saving a new address makes the previous report meaningless.
      setStatus(null);
    },
    onError: (err) =>
      toast.error(t('publicUrl.saveFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const check = useMutation({
    mutationFn: () => api.system.checkPublicUrl(),
    onSuccess: (res) => setStatus(res),
    onError: (err) =>
      toast.error(t('publicUrl.checkFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const cert = status?.certificate ?? null;
  const days = cert?.daysRemaining ?? null;

  /** The single sentence telling the operator what to do next. */
  const guidance = (): string | null => {
    if (!status || status.verdict === 'unset') return null;
    if (!status.reachable) return t('publicUrl.guide.unreachable');
    if (status.scheme === 'http') {
      return status.acme.port80Reachable
        ? t('publicUrl.guide.httpCanIssue')
        : t('publicUrl.guide.httpNoPort80');
    }
    if (cert && !cert.trusted) {
      return cert.selfSigned && status.acme.port80Reachable
        ? t('publicUrl.guide.selfSignedCanIssue')
        : t('publicUrl.guide.untrusted');
    }
    if (days != null && days <= 30) return t('publicUrl.guide.expiring', { days });
    return t('publicUrl.guide.ok');
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start gap-3">
          <Globe className="mt-1 h-5 w-5 text-muted-foreground" aria-hidden />
          <div className="flex-1">
            <h2 className="text-lg font-semibold">{t('publicUrl.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('publicUrl.description')}</p>
          </div>
          {status && (
            <Badge variant={VERDICT_VARIANT[status.verdict]}>
              {t(`publicUrl.verdict.${status.verdict}`)}
            </Badge>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="public-url">{t('publicUrl.field')}</Label>
          <Input
            id="public-url"
            value={url}
            disabled={!canManage}
            placeholder="https://ultratorrent.example.net:10443"
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('publicUrl.hint')}</p>
        </div>

        {status && status.verdict !== 'unset' && (
          <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium">{t('publicUrl.checksTitle')}</span>
            </div>

            <ul className="space-y-1.5">
              <CheckRow
                state={status.dns.resolved ? 'pass' : 'fail'}
                label={t('publicUrl.check.dns')}
                detail={status.dns.resolved ? status.dns.addresses.join(', ') : status.dns.error}
              />
              <CheckRow
                state={status.reachable ? 'pass' : 'fail'}
                label={t('publicUrl.check.reachable')}
                detail={
                  status.reachable ? `HTTP ${status.httpStatus ?? '-'}` : status.reachError
                }
              />
              <CheckRow
                state={status.scheme === 'https' ? 'pass' : 'fail'}
                label={t('publicUrl.check.https')}
                detail={status.scheme === 'http' ? t('publicUrl.check.httpsPlaintext') : null}
              />
              {status.scheme === 'https' && (
                <>
                  <CheckRow
                    state={cert?.trusted ? 'pass' : 'fail'}
                    label={t('publicUrl.check.trusted')}
                    detail={
                      cert
                        ? cert.trusted
                          ? t('publicUrl.check.issuedBy', { issuer: cert.issuer ?? '?' })
                          : cert.selfSigned
                            ? t('publicUrl.check.selfSigned')
                            : cert.trustError
                        : t('publicUrl.check.noCert')
                    }
                  />
                  <CheckRow
                    state={days == null ? 'na' : days <= 14 ? 'fail' : days <= 30 ? 'na' : 'pass'}
                    label={t('publicUrl.check.expiry')}
                    detail={
                      days == null
                        ? null
                        : t('publicUrl.check.daysRemaining', { days, date: cert?.validTo ?? '' })
                    }
                  />
                </>
              )}
              {/*
                Port 80 is listed even when TLS already works, because it is what
                renewal depends on: a forward removed after issuance breaks the
                certificate silently, ~60 days later.
              */}
              <CheckRow
                state={status.acme.port80Reachable ? 'pass' : 'fail'}
                label={t('publicUrl.check.acmePort')}
                detail={
                  status.acme.port80Reachable
                    ? t('publicUrl.check.acmeOpen')
                    : t('publicUrl.check.acmeClosed')
                }
              />
            </ul>

            {guidance() && <p className="text-xs text-muted-foreground">{guidance()}</p>}
            <p className="text-[11px] text-muted-foreground/70">
              {t('publicUrl.certNote')}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => check.mutate()}
            disabled={check.isPending || !q.data?.url}
          >
            <RefreshCw className={`h-4 w-4 ${check.isPending ? 'animate-spin' : ''}`} aria-hidden />
            {t('publicUrl.check.run')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canManage || save.isPending}>
            {t('publicUrl.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
