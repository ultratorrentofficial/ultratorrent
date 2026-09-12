import type { NetworkFacts, NetworkType } from './household-types';

/**
 * Classify a network from normalized GeoIP/ASN facts — the single seam that turns
 * an ISP/organization name into a `NetworkType`. Pure, offline, provider-agnostic:
 * no viewer IP ever leaves the host. When the source cannot distinguish VPN from a
 * datacenter it prefers the broader `hosting` rather than pretending certainty, and
 * an ISP it has no signal for stays `unknown` (never silently "residential").
 *
 * The keyword tables are deliberately central so classification logic is not
 * scattered through services, and so an admin override can replace the result.
 */
const MOBILE = /\b(mobile|wireless|cellular|t-?mobile|verizon wireless|at&?t mobility|sprint pcs|vodafone|orange|telefonica moviles|claro|movistar|airtel|reliance jio|\bjio\b|o2\b|ee limited|three\b|telcel|telus mobility|rogers wireless|bell mobility)\b/i;
const VPN = /\b(vpn|proxy|nordvpn|expressvpn|mullvad|private internet access|\bpia\b|torguard|surfshark|protonvpn|windscribe|cyberghost|ipvanish|tunnelbear|hide\.?me|perfect privacy)\b/i;
const HOSTING = /\b(amazon|aws|amazon technologies|google llc|google cloud|\bgcp\b|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|vultr|choopa|leaseweb|contabo|scaleway|colo(cation)?|data ?center|datacenter|hosting|host\b|dedicated servers?|cloud\b|m247|cogent|hostwinds|quadranet|oracle cloud|alibaba|tencent cloud|serverius)\b/i;
/** Well-known residential/telecom brands — a positive signal, not the only path. */
const RESIDENTIAL_HINT = /\b(comcast|xfinity|charter|spectrum|cox communications|centurylink|frontier|windstream|at&?t internet|at&?t services|verizon fios|verizon internet|liberty (communications|cablevision|global)|claro (hogar|fijo)|telefonica de|cable ?onda|optimum|altice|virgin media|sky broadband|bt group|talktalk|deutsche telekom|telecom italia|telmex|izzi|megacable|telus communications|bell canada|rogers cable|shaw|videotron|critical hub)\b/i;

export interface Classification {
  type: NetworkType;
  confidence: number;
  reasons: string[];
}

export function classifyNetwork(facts: Pick<NetworkFacts, 'isp' | 'asn' | 'kind'>): Classification {
  // A private/LAN or unresolved address is not a public network to classify.
  if (facts.kind !== 'public') return { type: 'unknown', confidence: 0, reasons: ['not_public'] };
  const isp = (facts.isp ?? '').trim();
  if (!isp) return { type: 'unknown', confidence: 20, reasons: ['no_isp_data'] };

  if (MOBILE.test(isp)) return { type: 'mobile', confidence: 80, reasons: ['isp_matches_mobile_carrier'] };
  if (VPN.test(isp)) return { type: 'vpn_proxy', confidence: 75, reasons: ['isp_matches_vpn_or_proxy'] };
  if (HOSTING.test(isp)) return { type: 'hosting', confidence: 70, reasons: ['isp_matches_hosting_or_datacenter'] };
  if (RESIDENTIAL_HINT.test(isp)) return { type: 'residential', confidence: 85, reasons: ['isp_matches_known_residential_provider'] };

  // A named public ISP that is not mobile/hosting/VPN is very likely a fixed
  // residential/business broadband provider — the common case — but at lower
  // confidence, and always overridable by an admin.
  return { type: 'residential', confidence: 55, reasons: ['named_public_isp_assumed_fixed_broadband'] };
}
