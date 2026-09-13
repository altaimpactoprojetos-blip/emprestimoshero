import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { parse } from '../../lib/validate.js';
import * as svc from './auth.service.js';
import { authenticate } from '../../middleware/auth.js';
import { config } from '../../config.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'eh_refresh';
const cookieOpts = { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' as const, path: '/api/auth', maxAge: config.jwtRefreshDays * 86400 * 1000 };

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });

const meta = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

function respondSession(res: Response, session: { accessToken: string; refreshToken: string; user: unknown }) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, cookieOpts);
  res.json({ accessToken: session.accessToken, user: session.user });
}

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const r = await svc.loginStaff(body.email, body.password, meta(req));
    if (r.twoFactorRequired) return res.json({ twoFactorRequired: true, twoFactorToken: r.twoFactorToken });
    respondSession(res, r);
  } catch (e) { next(e); }
});

authRouter.post('/login/2fa', loginLimiter, async (req, res, next) => {
  try {
    const body = parse(z.object({ twoFactorToken: z.string(), code: z.string().min(6).max(8) }), req.body);
    respondSession(res, await svc.loginTwoFactor(body.twoFactorToken, body.code, meta(req)));
  } catch (e) { next(e); }
});

authRouter.post('/portal/login', loginLimiter, async (req, res, next) => {
  try {
    const body = parse(z.object({ companySlug: z.string(), identifier: z.string().min(3), password: z.string().min(1) }), req.body);
    respondSession(res, await svc.loginClient(body.companySlug, body.identifier, body.password, meta(req)));
  } catch (e) { next(e); }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    respondSession(res, await svc.refreshSession(req.cookies?.[REFRESH_COOKIE], meta(req)));
  } catch (e) { next(e); }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    await svc.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

authRouter.post('/forgot-password', loginLimiter, async (req, res, next) => {
  try {
    const body = parse(z.object({ email: z.string().email(), companySlug: z.string().optional() }), req.body);
    await svc.requestPasswordReset(body.email, body.companySlug);
    res.json({ ok: true, message: 'Se o e-mail estiver cadastrado, enviaremos as instruções.' });
  } catch (e) { next(e); }
});

authRouter.post('/reset-password', loginLimiter, async (req, res, next) => {
  try {
    const body = parse(z.object({ token: z.string(), password: z.string() }), req.body);
    await svc.resetPassword(body.token, body.password);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

authRouter.get('/me', authenticate, async (req, res, next) => {
  try { res.json(await svc.publicUser(req.auth!.userId)); } catch (e) { next(e); }
});

authRouter.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
    await svc.changePassword(req.auth!.userId, body.currentPassword, body.newPassword);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

authRouter.post('/2fa/setup', authenticate, async (req, res, next) => {
  try { res.json(await svc.twoFactorSetup(req.auth!.userId)); } catch (e) { next(e); }
});
authRouter.post('/2fa/enable', authenticate, async (req, res, next) => {
  try {
    const body = parse(z.object({ code: z.string() }), req.body);
    await svc.twoFactorEnable(req.auth!.userId, body.code);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
authRouter.post('/2fa/disable', authenticate, async (req, res, next) => {
  try {
    const body = parse(z.object({ password: z.string() }), req.body);
    await svc.twoFactorDisable(req.auth!.userId, body.password);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
