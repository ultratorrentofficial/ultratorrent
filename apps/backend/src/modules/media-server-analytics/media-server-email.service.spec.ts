import * as nodemailer from 'nodemailer';
import { MediaServerEmailService } from './media-server-email.service';

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
  const svc = new MediaServerEmailService(prisma as any, cipher as any);
  return { svc, createTransport, sendMail };
}

const BASE = { host: 'smtp.local', fromAddress: 'ut@local', encryptedPass: 'enc:secret', user: 'bob' };

describe('MediaServerEmailService SMTP auth toggle', () => {
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
