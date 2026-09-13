import nodemailer from 'nodemailer';
import { config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

export interface MailResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  mode: 'smtp' | 'console';
}

export const mailerConfigured = (): boolean => Boolean(config.smtp.host);

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

export async function sendMail(msg: MailMessage): Promise<MailResult> {
  if (!mailerConfigured()) {
    console.log(`[e-mail/console] para=${msg.to} assunto="${msg.subject}"\n${msg.text}`);
    return { ok: true, providerId: `console-${Date.now()}`, mode: 'console' };
  }
  try {
    transport ??= nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
    const info = await transport.sendMail({ from: msg.from ?? config.smtp.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return { ok: true, providerId: info.messageId, mode: 'smtp' };
  } catch (e) {
    return { ok: false, error: (e as Error).message, mode: 'smtp' };
  }
}
