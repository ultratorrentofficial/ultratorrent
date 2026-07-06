import type { HealthResult, SendResult } from '../notification-provider';

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string; // decrypted at call time
  fromNumber?: string; // SMS sender or WhatsApp-enabled number
}

export const E164 = /^\+?[1-9]\d{6,14}$/;

/** POST a message to the Twilio Messaging API (form-encoded, basic auth). */
export async function sendTwilioMessage(
  cfg: TwilioConfig,
  params: { from: string; to: string; body: string; mediaUrl?: string | null },
): Promise<SendResult> {
  if (!cfg.accountSid || !cfg.authToken) return { ok: false, error: 'Twilio credentials not configured' };
  const form = new URLSearchParams({ From: params.from, To: params.to, Body: params.body });
  if (params.mediaUrl) form.set('MediaUrl', params.mediaUrl);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as { sid?: string; message?: string; code?: number };
    if (res.ok && json.sid) return { ok: true, providerMessageId: json.sid };
    return { ok: false, error: json.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Verify Twilio credentials by fetching the account resource. */
export async function twilioHealth(cfg: TwilioConfig): Promise<HealthResult> {
  if (!cfg.accountSid || !cfg.authToken) return { ok: false, status: 'offline', error: 'credentials not configured' };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? { ok: true, status: 'online' } : { ok: false, status: 'offline', error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 'offline', error: e instanceof Error ? e.message : String(e) };
  }
}
