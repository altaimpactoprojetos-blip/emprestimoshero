import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, zId } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import * as svc from './charges.service.js';
import { config } from '../../config.js';
import { paymentsConfigured } from '../../services/payments-provider.js';

export const chargesRouter = Router();
chargesRouter.use(authenticate, requireCompany);

chargesRouter.post('/', requirePermission('payments.register'), async (req, res, next) => {
  try {
    const body = parse(z.object({ installmentId: zId, type: z.enum(['PIX', 'BOLETO']) }), req.body);
    res.status(201).json(await svc.createCharge(req.auth!, body.installmentId, body.type));
  } catch (e) { next(e); }
});

chargesRouter.get('/reconciliation', requirePermission('installments.view'), async (req, res, next) => {
  try {
    const r = await svc.reconciliation(companyOf(req), typeof req.query.from === 'string' ? req.query.from : undefined, typeof req.query.to === 'string' ? req.query.to : undefined);
    res.json({ ...r, provider: config.payments.provider, configured: paymentsConfigured() });
  } catch (e) { next(e); }
});

chargesRouter.get('/webhook-events', requirePermission('installments.view'), async (req, res, next) => {
  try {
    // eventos vinculados a cobranças desta empresa
    const charges = await prisma.charge.findMany({ where: { companyId: companyOf(req) }, select: { externalId: true, provider: true } });
    const ids = new Set(charges.map((c) => c.externalId));
    const events = await prisma.webhookEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    res.json(events.filter((e) => ids.has(String((e.payload as { chargeId?: string })?.chargeId ?? ''))));
  } catch (e) { next(e); }
});

/** Simula a confirmação de pagamento pelo provedor de demonstração (dispara o mesmo fluxo do webhook). */
chargesRouter.post('/:id/simulate-paid', requirePermission('payments.register'), async (req, res, next) => {
  try {
    if (config.payments.provider !== 'mock') throw badRequest('Simulação disponível apenas com o provedor de demonstração');
    const c = await prisma.charge.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!c) throw notFound();
    const amount = typeof req.body?.amount === 'string' || typeof req.body?.amount === 'number' ? String(req.body.amount) : c.amount.toString();
    const fee = (Number(amount) * 0.01).toFixed(2);
    const body = { id: `evt-${c.externalId}-${Date.now()}`, type: 'charge.paid', chargeId: c.externalId, amount, paidAt: new Date().toISOString(), fee, netAmount: (Number(amount) - Number(fee)).toFixed(2) };
    res.json(await svc.processPaymentEvent('mock', body));
  } catch (e) { next(e); }
});
