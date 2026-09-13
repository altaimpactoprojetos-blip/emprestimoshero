import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../../lib/prisma.js';
import { parse, zDate, zDecimal, zId } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { badRequest } from '../../lib/errors.js';
import { storeFile } from '../../lib/storage.js';
import * as svc from './payments.service.js';
import { serializeBalance } from '../clients/clients.routes.js';
import { formatBRDate } from '../../lib/dates.js';

export const paymentsRouter = Router();
paymentsRouter.use(authenticate, requireCompany);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

paymentsRouter.get('/', requirePermission('installments.view'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const { from, to, status, clientId, loanId } = req.query as Record<string, string | undefined>;
    const items = await prisma.payment.findMany({
      where: { companyId, ...(status ? { status: status as never } : {}), ...(clientId ? { clientId } : {}), ...(loanId ? { loanId } : {}), ...(from || to ? { paidAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}) },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      include: { client: { select: { id: true, name: true } }, loan: { select: { id: true, number: true } }, installment: { select: { number: true, dueDate: true } }, proofFile: { select: { id: true, filename: true } }, charge: { select: { provider: true, type: true, feeAmount: true, netAmount: true } } },
      take: 2000,
    });
    res.json(items);
  } catch (e) { next(e); }
});

paymentsRouter.post('/', requirePermission('payments.register'), async (req, res, next) => {
  try {
    const input = parse(svc.paymentSchema, req.body);
    res.status(201).json(await svc.registerPayment(req.auth!, { ...input, source: 'MANUAL' }));
  } catch (e) { next(e); }
});

paymentsRouter.post('/proof-upload', requirePermission('payments.register'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('Envie o comprovante');
    const f = await storeFile(companyOf(req), req.file.originalname, req.file.mimetype, req.file.buffer, req.auth!.userId);
    res.status(201).json({ fileId: f.id, filename: f.filename });
  } catch (e) { next(e); }
});

paymentsRouter.post('/:id/reverse', requirePermission('payments.reverse'), async (req, res, next) => {
  try {
    const body = parse(z.object({ reason: z.string().min(5) }), req.body);
    res.json(await svc.reversePayment(req.auth!, String(req.params.id), body.reason));
  } catch (e) { next(e); }
});

paymentsRouter.post('/:id/review', requirePermission('payments.review'), async (req, res, next) => {
  try {
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), notes: z.string().optional() }), req.body);
    res.json(await svc.reviewProof(req.auth!, String(req.params.id), body.decision, body.notes));
  } catch (e) { next(e); }
});

paymentsRouter.get('/:id/receipt', requirePermission('installments.view'), async (req, res, next) => {
  try {
    const pdf = await svc.receiptPdf(companyOf(req), String(req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="recibo.pdf"');
    res.send(pdf);
  } catch (e) { next(e); }
});

// ---- Quitação antecipada ----
paymentsRouter.get('/payoff/:loanId', requirePermission('renegotiate'), async (req, res, next) => {
  try {
    const p = await svc.payoffPreview(companyOf(req), String(req.params.loanId), typeof req.query.asOf === 'string' ? req.query.asOf : undefined);
    res.json({ asOf: p.asOf.toISOString().slice(0, 10), items: p.items.map((i) => ({ installmentId: i.installment.id, number: i.installment.number, dueDate: formatBRDate(i.installment.dueDate), principal: i.principal.toFixed(2), interest: i.interest.toFixed(2), charges: i.charges.toFixed(2), waivedInterest: i.waivedInterest.toFixed(2), total: i.total.toFixed(2) })), totals: Object.fromEntries(Object.entries(p.totals).map(([k, v]) => [k, v.toFixed(2)])) });
  } catch (e) { next(e); }
});
paymentsRouter.post('/payoff/:loanId', requirePermission('renegotiate'), async (req, res, next) => {
  try {
    const body = parse(z.object({ paidAt: zDate, method: z.enum(['PIX', 'BOLETO', 'CASH', 'TRANSFER', 'CARD', 'OTHER']), extraDiscount: zDecimal.optional(), notes: z.string().optional() }), req.body);
    res.json(await svc.payoffLoan(req.auth!, String(req.params.loanId), body));
  } catch (e) { next(e); }
});

// ---- Renegociação ----
paymentsRouter.post('/renegotiate/:loanId/preview', requirePermission('renegotiate'), async (req, res, next) => {
  try {
    const body = parse(z.object({ installmentIds: z.array(zId).min(1), asOf: zDate, discount: zDecimal.default('0') }), req.body);
    const p = await svc.renegotiationPreview(companyOf(req), String(req.params.loanId), body.installmentIds, body.asOf, body.discount);
    res.json({ balances: p.balances.map((b) => ({ installmentId: b.installment.id, number: b.installment.number, dueDate: b.installment.dueDate, balance: serializeBalance(b.balance) })), balanceBefore: p.balanceBefore.toFixed(2), discount: p.discount.toFixed(2), balanceRenegotiated: p.balanceRenegotiated.toFixed(2) });
  } catch (e) { next(e); }
});
paymentsRouter.post('/renegotiate/:loanId', requirePermission('renegotiate'), async (req, res, next) => {
  try {
    const body = parse(svc.renegotiationSchema, req.body);
    res.status(201).json(await svc.renegotiate(req.auth!, String(req.params.loanId), body));
  } catch (e) { next(e); }
});
