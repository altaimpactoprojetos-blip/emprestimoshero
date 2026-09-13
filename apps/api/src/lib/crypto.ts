import crypto from 'node:crypto';
import { config } from '../config.js';

export const sha256 = (v: string | Buffer): string => crypto.createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

const key = Buffer.from(config.encryptionKey, 'hex');

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join('.');
}

export function decrypt(payload: string): string {
  const [ivH, tagH, encH] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivH, 'hex'));
  decipher.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encH, 'hex')), decipher.final()]).toString('utf8');
}

export function hmacSign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function hmacVerify(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = hmacSign(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
