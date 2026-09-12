import { classifyNetwork } from './network-classifier';

const pub = (isp: string | null, asn: number | null = 1) => ({ isp, asn, kind: 'public' as const });

describe('classifyNetwork', () => {
  it('classifies a mobile carrier as mobile', () => {
    expect(classifyNetwork(pub('T-Mobile USA')).type).toBe('mobile');
    expect(classifyNetwork(pub('Verizon Wireless')).type).toBe('mobile');
    expect(classifyNetwork(pub('Claro Movistar Wireless')).type).toBe('mobile');
  });
  it('classifies hosting/datacenter as hosting', () => {
    expect(classifyNetwork(pub('Amazon Technologies Inc.')).type).toBe('hosting');
    expect(classifyNetwork(pub('DigitalOcean, LLC')).type).toBe('hosting');
    expect(classifyNetwork(pub('OVH SAS')).type).toBe('hosting');
  });
  it('classifies a VPN as vpn_proxy', () => {
    expect(classifyNetwork(pub('Mullvad VPN AB')).type).toBe('vpn_proxy');
    expect(classifyNetwork(pub('NordVPN')).type).toBe('vpn_proxy');
  });
  it('classifies a known residential ISP as residential (high confidence)', () => {
    const c = classifyNetwork(pub('Charter Communications Inc'));
    expect(c.type).toBe('residential');
    expect(c.confidence).toBeGreaterThanOrEqual(80);
  });
  it('assumes fixed broadband for a named public ISP, at lower confidence', () => {
    const c = classifyNetwork(pub('Some Regional Cable Co'));
    expect(c.type).toBe('residential');
    expect(c.confidence).toBeLessThan(80);
  });
  it('stays unknown with no ISP data, and never silently residential', () => {
    expect(classifyNetwork(pub(null)).type).toBe('unknown');
  });
  it('does not classify a private/LAN address', () => {
    expect(classifyNetwork({ isp: 'x', asn: 1, kind: 'private' }).type).toBe('unknown');
  });
});
