import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { HouseholdRiskLevel, HouseholdNetworkType, HouseholdReason } from '@/lib/api';

const RISK_CLS: Record<HouseholdRiskLevel, string> = {
  none: 'text-muted-foreground border-white/10',
  low: 'text-success border-success/30',
  medium: 'text-warning border-warning/40',
  high: 'text-destructive border-destructive/40',
  critical: 'text-destructive border-destructive/60 bg-destructive/10',
};

export function RiskBadge({ level, score }: { level: HouseholdRiskLevel; score?: number }) {
  const { t } = useTranslation('mediaServerAnalytics');
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${RISK_CLS[level]}`}>
      {t(`household.risk.${level}`)}{typeof score === 'number' ? ` ${score}` : ''}
    </span>
  );
}

const NET_CLS: Record<HouseholdNetworkType, string> = {
  residential: 'text-success border-success/30',
  mobile: 'text-info border-info/30',
  hosting: 'text-warning border-warning/40',
  vpn_proxy: 'text-warning border-warning/40',
  unknown: 'text-muted-foreground border-white/10',
};

export function NetworkTypeBadge({ type }: { type: HouseholdNetworkType }) {
  const { t } = useTranslation('mediaServerAnalytics');
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${NET_CLS[type]}`}>{t(`household.networkType.${type}`)}</span>;
}

/** Localize a reason code, with the delta and any coarse details appended. */
export function reasonText(t: TFunction<'mediaServerAnalytics'>, r: HouseholdReason): string {
  const label = t(`household.reason.${r.code}` as never, { defaultValue: r.code });
  const sign = r.delta > 0 ? `+${r.delta}` : `${r.delta}`;
  return r.delta !== 0 ? `${sign}  ${label}` : label;
}

export function ReasonList({ reasons }: { reasons: HouseholdReason[] | null | undefined }) {
  const { t } = useTranslation('mediaServerAnalytics');
  if (!reasons || reasons.length === 0) return <span className="text-xs text-muted-foreground">{t('household.reason.none')}</span>;
  return (
    <ul className="space-y-0.5 text-xs">
      {reasons.map((r, i) => (
        <li key={i} className={r.delta > 0 ? 'text-foreground' : 'text-muted-foreground'}>
          <span className="font-mono tabular-nums">{r.delta > 0 ? `+${r.delta}` : r.delta === 0 ? ' 0' : r.delta}</span>{'  '}
          {t(`household.reason.${r.code}` as never, { defaultValue: r.code })}
        </li>
      ))}
    </ul>
  );
}

export const watchHours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 60)}m`);
