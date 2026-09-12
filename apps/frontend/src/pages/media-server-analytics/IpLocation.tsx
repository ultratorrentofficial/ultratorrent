import { useTranslation } from 'react-i18next';
import type { GeoResult } from '@/lib/api';
import { CountryFlag } from './CountryFlag';

/**
 * A viewer's address and where it resolves to.
 *
 * Three honest states, matching the backend's `GeoResult.kind`:
 *  - a LAN address is shown as **Local** — there is no public geography;
 *  - a placed public address shows a flag and "City, Country", plus the IP;
 *  - a public address the database could not place (or with no database loaded)
 *    shows just the IP, so the operator still sees where a stream came from.
 *
 * `inline` keeps it all on one line (flag · place · IP) for a dense card row;
 * the default stacks the IP beneath the place, which reads better in a table.
 */
export function IpLocation({
  ip,
  geo,
  inline = false,
}: {
  ip: string | null;
  geo: GeoResult | null;
  inline?: boolean;
}) {
  const { t } = useTranslation('mediaServerAnalytics');
  const addr = (ip ?? '').trim();
  if (!addr) return <span className="text-muted-foreground">—</span>;

  if (geo?.kind === 'private') {
    return (
      <span className="text-muted-foreground" title={addr}>
        {t('ip.local')}
      </span>
    );
  }

  const loc = geo?.location ?? null;
  const place = loc ? [loc.city, loc.region, loc.country].filter(Boolean).join(', ') : null;
  // The ISP/organisation comes from the ASN database — shown alongside the place.
  const isp = geo?.isp ?? null;

  if (!place && !isp) {
    // Public but unplaced and no ISP (or no database) — the address alone.
    return <span className="font-mono text-xs tabular-nums">{addr}</span>;
  }

  if (inline) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {loc?.countryCode && <CountryFlag code={loc.countryCode} />}
        {place && <span>{place}</span>}
        {isp && <span className="text-muted-foreground">· {isp}</span>}
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80">{addr}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col leading-tight">
      {place && (
        <span className="flex items-center gap-1.5">
          <CountryFlag code={loc?.countryCode} />
          <span>{place}</span>
        </span>
      )}
      {isp && <span className="text-[10px] text-muted-foreground">{isp}</span>}
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{addr}</span>
    </span>
  );
}
