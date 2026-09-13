import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../../lib/prisma.js';
import { parse, zDate, zDecimal, zId, onlyDigits } from '../../lib/validate.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { badRequest, notFound, forbidden } from '../../lib/errors.js';
import { computeBalance } from '../../domain/installment.js';
import { todayIn } from '../../lib/dates.js';
import { sum } from '../../lib/money.js';
import { storeFile, readFile } from '../../lib/storage.js';
import { registerPayment, receiptPdf } from '../payments/payments.service.js';
import { createCharge } from '../payments/charges.service.js';
import { serializeBalance } from '../clients/clients.routes.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';
import type { AuthContext } from '../../middleware/auth.js';

/**
 * Portal do cliente: acesso restrito ao próprio cliente (req.auth.clientId) dentro da sua empresa.
 * Nenhuma rota aceita identificador de outro cliente.
 */
export const portalRouter = Router();
portalRouter.use(authenticate, requireRole('CLIENT'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const scope = (req: { auth?: AuthContext }) => {
  const a = req.auth!;
  if (!a.clientId || !a.companyId) throw forbidden();
  return { clientId: a.clientId, companyId: a.companyId };
};

portalRouter.get('/me', async (req, res, next) => {
  try {
    const { clientId, companyId } = scope(req);
    const [client, company, loans, unread] = await Promise.all([
      prisma.client.findUniqueOrThrow({ where: { id: clientId } }),
      prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { id: true, name: true, slug: true, email: true, phone: true, logoFileId: true, primaryColor: true, secondaryColor: true, timezone: true, settings: true } }),
      prisma.loan.findMany({ where: { clientId, companyId, status: { in: ['AWAITING_SIGNATURE', 'SIGNED', 'ACTIVE', 'PAID', 'RENEGOTIATED'] } }, orderBy: { number: 'desc' }, include: { installments: { orderBy: { number: 'asc' }, include: { charges: { where: { status: 'PENDING' } } } }, contracts: { where: { status: { in: ['AWAITING_SIGNATURE', 'SIGNED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, version: true, kind: true, status: true, signedAt: true } } } }),
      prisma.notification.count({ where: { clientId, readAt: null } }),
    ]);
    const today = todayIn(company.timezone);
    const settings = (company.settings ?? {}) as { pixKey?: string; paymentInstructions?: string };
    const out = loans.map((l) => {
      const installments = l.installments.map((i) => ({ ...i, balance: serializeBalance(computeBalance(i, l, today)) }));
      const open = installments.filter((i) => ['PENDING', 'PARTIAL'].includes(i.status));
      return { id: l.id, number: l.number, status: l.status, principalAmount: l.principalAmount, disbursedAmount: l.disbursedAmount, installmentsCount: l.installmentsCount, installmentAmount: l.installmentAmount, periodicity: l.periodicity, monthlyRate: l.monthlyRate, cetAnnual: l.cetAnnual, totalAmount: l.totalAmount, disbursedAt: l.disbursedAt, firstDueDate: l.firstDueDate, calcMethod: l.calcMethod, collectionState: l.collectionState, contracts: l.contracts, installments, summary: { openBalance: l.status === 'ACTIVE' ? sum(open.map((i) => i.balance.totalDue)).toFixed(2) : '0.00', overdueBalance: sum(open.filter((i) => i.balance.daysLate > 0).map((i) => i.balance.totalDue)).toFixed(2), overdueCount: open.filter((i) => i.balance.daysLate > 0).length, paidCount: installments.filter((i) => i.status === 'PAID').length, nextDue: open[0] ? { number: open[0].number, dueDate: open[0].dueDate, amount: open[0].balance.totalDue } : null } };
    });
    res.json({ client: { id: client.id, name: client.name, document: client.document, email: client.email, phone: client.phone, contactPreferences: client.contactPreferences }, company: { ...company, settings: { pixKey: settings.pixKey ?? null, paymentInstructions: settings.paymentInstructions ?? null } }, loans: out, unreadNotifications: unread, totals: { openBalance: sum(out.map((l) => l.summary.openBalance)).toFixed(2), overdueBalance: sum(out.map((l) => l.summary.overdueBalance)).toFixed(2) }, paymentsProvider: config.payments.provider, today: today.toISOString().slice(0, 10) });
  } catch (e) { next(e); }
});

portalRouter.get('/payments', async (req, res, next) => {
  try {
    const { clientId, companyId } = scope(req);
    res.json(await prisma.payment.findMany({ where: { clientId, companyId, status: { in: ['CONFIRMED', 'PENDING_REVIEW', 'REJECTED'] } }, orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }], include: { loan: { select: { number: true } }, installment: { select: { number: true } } } }));
  } catch (e) { next(e); }
});

portalRouter.get('/payments/:id/receipt', async (req, res, next) => {
  try {
    const { clientId, companyId } = scope(req);
    const p = await prisma.payment.findFirst({ where: { id: String(req.params.id), clientId, companyId } });
    if (!p) throw notFound();
    const pdf = await receiptPdf(companyId, p.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="recibo.pdf"');
    res.send(pdf);
  } catch (e) { next(e); }
});

portalRouter.get('/contracts/:id/pdf', async (req, res, next) => {
  try {
    const { clientId, companyId } = scope(req);
    const c = await prisma.contract.findFirst({ where: { id: String(req.params.id), companyId, loan: { clientId }, status: { in: ['AWAITING_SIGNATURE', 'SIGNED'] } } });
    if (!c?.fileId) throw notFound('Contrato não disponível');
    const f = await readFile(companyId, c.fileId);
    if (!f) throw notFound();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${f.file.filename}"`);
    res.send(f.data);
  } catch (e) { next(e); }
});

/** Cliente solicita cobrança Pix/boleto para uma parcela própria. */
portalRouter.post('/charges', async (req, res, next) => {
  try {
    const { clientId, companyId } = scope(req);
    const body = parse(z.object({ installmentId: zId, type: z.enum(['PIX', 'BOLETO']) }), req.body);
    const inst = await prisma.installment.findFirst({ where: { id: body.installmentId, companyId, loan: { clientId } } });
    if (!inst) throw notFound('Parcela não encontrada');
    const ctx: AuthContext = { ...req.auth!, permissions: new Set() };
    res.status(201).json(await createCharge(ctx, inst.id, body.type));
  } catch (e) { next(e); }
});

/** Envio de comprovante: fica pendente de conferência pela empresa. */
portalRouter.post('/proofs', upload.single('file'), async (req, res, next) => {
  try {
    const { clientId, companyId } = scope(req);
    const body = parse(z.object({ installmentId: zId, amount: zDecimal, paidAt: zDate, notes: z.string().optional() }), req.body);
    const inst = await prisma.installment.findFirst({ where: { id: body.installmentId, companyId, loan: { clientId } } });
    if (!inst) throw notFound('Parcela não encontrada');
    if (!req.file) throw badRequest('Anexe o comprovante');
    const file = await storeFile(companyId, req.file.originalname, req.file.mimetype, req.file.buffer, req.auth!.userId);
    const ctx: AuthContext = { ...req.auth!, permissions: new Set() };
    const p = await registerPayment(ctx, { installmentId: inst.id, amount: body.amount, discount: '0', method: 'PIX', paidAt: body.paidAt, notes: body.notes ?? null, proofFileId: file.id, source: 'CLIENT_UPLOAD' }, { status: 'PENDING_REVIEW', receivedByName: 'Cliente (portal)' });
    res.status(201).json(p);
  } catch (e) { next(e); }
});

portalRouter.put('/preferences', async (req, res, next) => {
  try {
    const { clientId, companyId } = scope(req);
    const body = parse(z.object({ email: z.string().email().optional().nullable(), phone: z.string().optional().nullable(), contactPreferences: z.object({ email: z.boolean(), sms: z.boolean(), portal: z.boolean() }).partial() }), req.body);
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const c = await prisma.client.update({ where: { id: clientId }, data: { email: body.email === undefined ? undefined : body.email, phone: body.phone === undefined ? undefined : body.phone ? onlyDigits(body.phone) : null, contactPreferences: { ...(before.contactPreferences as object), ...body.contactPreferences } } });
    await audit({ ...req.auth!, companyId }, { action: 'CLIENT_PREFERENCES_UPDATE', entity: 'Client', entityId: clientId, before: { email: before.email, phone: before.phone, contactPreferences: before.contactPreferences }, after: { email: c.email, phone: c.phone, contactPreferences: c.contactPreferences } });
    res.json({ email: c.email, phone: c.phone, contactPreferences: c.contactPreferences });
  } catch (e) { next(e); }
});

portalRouter.get('/requests', async (req, res, next) => {
  try { const { clientId } = scope(req); res.json(await prisma.serviceRequest.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, include: { loan: { select: { number: true } } } })); } catch (e) { next(e); }
});
portalRouter.post('/requests', async (req, res, next) => {
  try {
    const { clientId, companyId } = scope(req);
    const body = parse(z.object({ type: z.enum(['SUPPORT', 'RENEGOTIATION', 'DISPUTE']), message: z.string().min(5), loanId: zId.optional().nullable() }), req.body);
    if (body.loanId) { const l = await prisma.loan.findFirst({ where: { id: body.loanId, clientId } }); if (!l) throw notFound('Contrato não encontrado'); }
    const sr = await prisma.serviceRequest.create({ data: { companyId, clientId, loanId: body.loanId ?? null, type: body.type, message: body.message } });
    if (body.type === 'DISPUTE' && body.loanId) {
      // contestação pausa automaticamente a cobrança do contrato até análise
      await prisma.loan.update({ where: { id: body.loanId }, data: { collectionState: 'PAUSED', collectionPauseReason: 'Contestação aberta pelo cliente no portal' } });
      await prisma.reminder.updateMany({ where: { installment: { loanId: body.loanId }, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelReason: 'Contestação aberta pelo cliente' } });
    }
    await audit({ ...req.auth!, companyId }, { action: 'SERVICE_REQUEST_CREATE', entity: 'ServiceRequest', entityId: sr.id, after: sr });
    res.status(201).json(sr);
  } catch (e) { next(e); }
});

portalRouter.get('/notifications', async (req, res, next) => {
  try { const { clientId } = scope(req); res.json(await prisma.notification.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, take: 100 })); } catch (e) { next(e); }
});
portalRouter.post('/notifications/read', async (req, res, next) => {
  try { const { clientId } = scope(req); await prisma.notification.updateMany({ where: { clientId, readAt: null }, data: { readAt: new Date() } }); res.json({ ok: true }); } catch (e) { next(e); }
});
