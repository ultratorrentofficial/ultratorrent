import * as nodemailer from 'nodemailer';
import { MailTransportService } from './mail-transport.service';

jest.mock('nodemailer');

/** Captures the transport options nodemailer is created with. */
function setup(config: Record<string, unknown>) {
  const sendMail = jest.fn().mockResolvedValue(undefined);
  const createTransport = nodemailer.createTransport as jest.Mock;
  createTransport.mockReturnValue({ sendMail });
  const prisma = {
    setting: {
      findUnique: jest.fn().mockResolvedValue({ value: config }),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
  };
  const cipher = { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') };
  // The auth toggle lives in the shared transport now; the newsletter service
  // is a façade over it, so the behaviour is tested where it actually is.
  const svc = new MailTransportService(prisma as any, cipher as any);
  return { svc, createTransport, sendMail, prisma };
}

const BASE = { host: 'smtp.local', fromAddress: 'ut@local', encryptedPass: 'enc:secret', user: 'bob' };

describe('MailTransportService SMTP auth toggle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('omits auth when auth is explicitly disabled, even with a username', async () => {
    const { svc, createTransport } = setup({ ...BASE, auth: false });
    await svc.send({ to: 'x@y', subject: 's', html: 'h', text: 't' });
    expect(createTransport.mock.calls[0][0].auth).toBeUndefined();
  });

  it('sends auth (user/pass) when enabled', async () => {
    const { svc, createTransport } = setup({ ...BASE, auth: true });
    await svc.send({ to: 'x@y', subject: 's', html: 'h', text: 't' });
    expect(createTransport.mock.calls[0][0].auth).toEqual({ user: 'bob', pass: 'secret' });
  });

  it('back-compat: no explicit flag + a username still authenticates', async () => {
    const { svc, createTransport } = setup({ ...BASE }); // no `auth` key
    await svc.send({ to: 'x@y', subject: 's', html: 'h', text: 't' });
    expect(createTransport.mock.calls[0][0].auth).toEqual({ user: 'bob', pass: 'secret' });
  });

  it('getSettings surfaces the auth flag (defaulting to username presence)', async () => {
    const withoutFlag = await setup({ ...BASE }).svc.getSettings();
    expect(withoutFlag.auth).toBe(true);
    const disabled = await setup({ host: 'h', fromAddress: 'f', auth: false }).svc.getSettings();
    expect(disabled.auth).toBe(false);
  });
});

describe('MailTransportService TLS certificate name', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not set a servername when none is configured', async () => {
    // nodemailer defaults `servername` to the host, which is right whenever the
    // two agree — sending our own value there would only be a chance to disagree.
    const { svc, createTransport } = setup({ ...BASE, auth: false });
    await svc.send({ to: 'x@y', subject: 's', html: 'h', text: 't' });
    expect(createTransport.mock.calls[0][0].tls).toBeUndefined();
  });

  it('verifies against the configured name when the host is not on the certificate', async () => {
    /*
     * The live case: the relay is only reachable at 10.20.30.26, and its
     * certificate is a wildcard for *.ultranetpr.com with no IP SAN. Connecting
     * by IP fails STARTTLS with ERR_TLS_CERT_ALTNAME_INVALID however the
     * TLS/SSL toggle is set, because `secure: false` only governs whether the
     * connection STARTS in TLS, not whether it upgrades into one.
     */
    const { svc, createTransport } = setup({
      ...BASE, auth: false, host: '10.20.30.26', secure: false,
      tlsServername: 'pmg01.ultranetpr.com',
    });
    await svc.send({ to: 'x@y', subject: 's', html: 'h', text: 't' });
    const opts = createTransport.mock.calls[0][0];
    expect(opts.host).toBe('10.20.30.26');
    expect(opts.tls).toEqual({ servername: 'pmg01.ultranetpr.com' });
  });

  it('never disables verification', async () => {
    // Naming the identity is the fix; switching verification off is a different
    // and much larger concession that this feature deliberately does not offer.
    const { svc, createTransport } = setup({ ...BASE, auth: false, tlsServername: 'mail.example.com' });
    await svc.send({ to: 'x@y', subject: 's', html: 'h', text: 't' });
    expect(createTransport.mock.calls[0][0].tls).not.toHaveProperty('rejectUnauthorized');
  });

  it('reports the configured name back to the settings screen', async () => {
    const { svc } = setup({ ...BASE, tlsServername: 'pmg01.ultranetpr.com' });
    await expect(svc.getSettings()).resolves.toMatchObject({ tlsServername: 'pmg01.ultranetpr.com' });
  });

  it('defaults to an empty name so the screen renders a blank field, not undefined', async () => {
    const { svc } = setup({ ...BASE });
    await expect(svc.getSettings()).resolves.toMatchObject({ tlsServername: '' });
  });

  /** What updateSettings actually persisted (the stubbed read cannot show it). */
  const written = (prisma: any) => prisma.setting.upsert.mock.calls[0][0].update.value;

  it('clearing the field goes back to verifying against the host', async () => {
    // Empty string is a real instruction, not an omission — it must not fall
    // through to the stored value the way an absent field does.
    const { svc, prisma } = setup({ ...BASE, tlsServername: 'pmg01.ultranetpr.com' });
    await svc.updateSettings({ tlsServername: '   ' });
    expect(written(prisma).tlsServername).toBeUndefined();
  });

  it('leaves the name alone when the field is not submitted at all', async () => {
    const { svc, prisma } = setup({ ...BASE, tlsServername: 'pmg01.ultranetpr.com' });
    await svc.updateSettings({ fromName: 'Something else' });
    expect(written(prisma).tlsServername).toBe('pmg01.ultranetpr.com');
  });
});
