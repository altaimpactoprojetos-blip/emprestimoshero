import { config } from '../config.js';

export interface SmsResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  mode: 'twilio' | 'console';
}

export const smsConfigured = (): boolean => config.sms.provider === 'twilio' && Boolean(config.sms.twilioSid && config.sms.twilioToken && config.sms.twilioFrom);

/** Normaliza para E.164 (Brasil). */
export function normalizePhone(phone: string): string | null {
  const d = phone.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if (d.length === 12 || d.length === 13) return `+${d}`;
  return null;
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: 'Telefone inválido', mode: smsConfigured() ? 'twilio' : 'console' };
  if (!smsConfigured()) {
    console.log(`[sms/console] para=${phone}\n${body}`);
    return { ok: true, providerId: `console-${Date.now()}`, mode: 'console' };
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.sms.twilioSid}/Messages.json`;
    const params = new URLSearchParams({ To: phone, From: config.sms.twilioFrom, Body: body });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.sms.twilioSid}:${config.sms.twilioToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const json = (await res.json()) as { sid?: string; message?: string };
    if (!res.ok) return { ok: false, error: json.message ?? `HTTP ${res.status}`, mode: 'twilio' };
    return { ok: true, providerId: json.sid, mode: 'twilio' };
  } catch (e) {
    return { ok: false, error: (e as Error).message, mode: 'twilio' };
  }
}
