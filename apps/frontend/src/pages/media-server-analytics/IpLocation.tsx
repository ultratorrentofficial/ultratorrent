import { useTranslation } from 'react-i18next';
import type { GeoResult } from '@/lib/api';

/**
 * A viewer's address and where it resolves to.
 *
 * Three honest states, matching the backend's `GeoResult.kind`:
 *  - a LAN address is shown as **Local** — there is no public geography;
 *  - a placed public address shows a flag and "City, Country", the IP beneath;
 *  - a public address the database could not place (or with no database loaded)
 *    shows just the IP, so the operator still sees where a stream came from.
 */
export function IpLocation({ ip, geo }: { ip: string | null; geo: GeoResult | null }) {
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
  const flag = loc?.countryCode ? flagEmoji(loc.countryCode) : null;

  if (!place) {
    // Public but unplaced, or no database — the address alone.
    return <span className="font-mono text-xs tabular-nums">{addr}</span>;
  }

  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="flex items-center gap-1">
        {flag && <span aria-hidden>{flag}</span>}
        <span>{place}</span>
      </span>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{addr}</span>
    </span>
  );
}

/**
 * A country flag from an ISO-3166 alpha-2 code, via regional-indicator symbols.
 * Returns null for anything that is not two ASCII letters, so a bad code renders
 * nothing rather than tofu.
 */
function flagEmoji(countryCode: string): string | null {
  const cc = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  const base = 0x1f1e6; // regional indicator 'A'
  return String.fromCodePoint(base + (cc.charCodeAt(0) - 65), base + (cc.charCodeAt(1) - 65));
}
