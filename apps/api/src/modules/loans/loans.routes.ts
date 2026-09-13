import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, zDecimal, zDate } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import * as svc from './loans.service.js';
import { computeBalance } from '../../domain/installment.js';
import { todayIn } from '../../lib/dates.js';
import { sum } from '../../lib/money.js';

export const loansRouter = Router();
loansRouter.use(authenticate, requireCompany);

// ---- Produtos (condições padrão) ----
const productSchema = z.object({
  name: z.string().min(2),
  calcMethod: z.enum(['PRICE', 'SAC', 'SIMPLE']).default('PRICE'),
  monthlyRate: zDecimal,
  originationFee: zDecimal.default('0'),
  originationFeeRate: zDecimal.default('0'),
  iofFixedRate: zDecimal.default('0'),
  iofDailyRate: zDecimal.default('0'),
  chargeMode: z.enum(['DEDUCTED', 'FINANCED']).default('DEDUCTED'),
  lateFineRate: zDecimal.default('2'),
  lateInterestMonthly: zDecimal.default('1'),
  legalNotes: z.string().optional().nullable(),
  legallyReviewed: z.boolean().default(false),
  active: z.boolean().default(true),
});

loansRouter.get('/products', requirePermission('loans.view'), async (req, res, next) => {
  try { res.json(await prisma.loanProduct.findMany({ where: { companyId: companyOf(req) }, orderBy: { name: 'asc' } })); } catch (e) { next(e); }
});
loansRouter.post('/products', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const data = parse(productSchema, req.body);
    const p = await prisma.loanProduct.create({ data: { ...data, companyId: companyOf(req) } });
    await audit(req.auth!, { action: 'PRODUCT_CREATE', entity: 'LoanProduct', entityId: p.id, after: p });
    res.status(201).json(p);
  } catch (e) { next(e); }
});
loansRouter.put('/products/:id', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const before = await prisma.loanProduct.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!before) throw notFound();
    const data = parse(productSchema.partial(), req.body);
    const p = await prisma.loanProduct.update({ where: { id: before.id }, data });
    await audit(req.auth!, { action: 'PRODUCT_UPDATE', entity: 'LoanProduct', entityId: p.id, before, after: p });
    res.json(p);
  } catch (e) { next(e); }
});

// ---- Simulação (não persiste) ----
loansRouter.post('/simulate', requirePermission('loans.view'), async (req, res, next) => {
  try {
    const input = parse(svc.simulationSchema, req.body);
    res.json(svc.serializeSimulation(svc.runSimulation(input)));
  } catch (e) { next(e); }
});

// ---- Empréstimos ----
loansRouter.get('/', requirePermission('loans.view'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.split(',') : undefined;
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
    const loans = await prisma.loan.findMany({
      where: { companyId, ...(status ? { status: { in: status as never } } : {}), ...(clientId ? { clientId } : {}) },
      orderBy: { number: 'desc' },
      include: { client: { select: { id: true, name: true, document: true } }, installments: { where: { status: { in: ['PENDING', 'PARTIAL'] } } }, contracts: { select: { status: true } } },
      take: 2000,
    });
    const today = todayIn(await svc.companyTimezone(companyId));
    res.json(loans.map((l) => {
      const balances = l.status === 'ACTIVE' ? l.installments.map((i) => computeBalance(i, l, today)) : [];
      return {
        ...l,
        installments: undefined,
        summary: {
          openBalance: sum(balances.map((b) => b.totalDue)).toFixed(2),
          overdueBalance: sum(balances.filter((b) => b.daysLate > 0).map((b) => b.totalDue)).toFixed(2),
          maxDaysLate: Math.max(0, ...balances.map((b) => b.daysLate)),
          openInstallments: l.installments.length,
          signedContract: l.contracts.some((c) => c.status === 'SIGNED'),
        },
      };
    }));
  } catch (e) { next(e); }
});

loansRouter.post('/', requirePermission('loans.create'), async (req, res, next) => {
  try {
    const input = parse(svc.loanInputSchema, req.body);
    const loan = await svc.createLoan(req.auth!, input);
    res.status(201).json(loan);
  } catch (e) { next(e); }
});

loansRouter.get('/:id', requirePermission('loans.view'), async (req, res, next) => {
  try { res.json(await svc.loanDetail(companyOf(req), String(req.params.id))); } catch (e) { next(e); }
});

loansRouter.put('/:id', requirePermission('loans.create'), async (req, res, next) => {
  try {
    const input = parse(svc.loanInputSchema, req.body);
    res.json(await svc.updateLoan(req.auth!, String(req.params.id), input));
  } catch (e) { next(e); }
});

const transitionBody = z.object({ notes: z.string().optional(), score: z.number().int().min(0).max(1000).optional(), reason: z.string().optional(), date: zDate.optional() });
loansRouter.post('/:id/submit', requirePermission('loans.create'), async (req, res, next) => { try { res.json(await svc.transition(req.auth!, String(req.params.id), 'submit', parse(transitionBody, req.body ?? {}))); } catch (e) { next(e); } });
loansRouter.post('/:id/assess', requirePermission('loans.create'), async (req, res, next) => { try { res.json(await svc.transition(req.auth!, String(req.params.id), 'assess', parse(transitionBody, req.body ?? {}))); } catch (e) { next(e); } });
loansRouter.post('/:id/approve', requirePermission('loans.approve'), async (req, res, next) => { try { res.json(await svc.transition(req.auth!, String(req.params.id), 'approve', parse(transitionBody, req.body ?? {}))); } catch (e) { next(e); } });
loansRouter.post('/:id/reject', requirePermission('loans.approve'), async (req, res, next) => { try { res.json(await svc.transition(req.auth!, String(req.params.id), 'reject', parse(transitionBody, req.body ?? {}))); } catch (e) { next(e); } });
loansRouter.post('/:id/disburse', requirePermission('loans.disburse'), async (req, res, next) => { try { res.json(await svc.transition(req.auth!, String(req.params.id), 'disburse', parse(transitionBody, req.body ?? {}))); } catch (e) { next(e); } });
loansRouter.post('/:id/cancel', requirePermission('loans.approve'), async (req, res, next) => { try { res.json(await svc.transition(req.auth!, String(req.params.id), 'cancel', parse(transitionBody, req.body ?? {}))); } catch (e) { next(e); } });

loansRouter.post('/:id/collection/pause', requirePermission('collections.manage'), async (req, res, next) => {
  try { res.json(await svc.setCollectionState(req.auth!, String(req.params.id), 'PAUSED', parse(z.object({ reason: z.string().optional() }), req.body ?? {}).reason)); } catch (e) { next(e); }
});
loansRouter.post('/:id/collection/resume', requirePermission('collections.manage'), async (req, res, next) => {
  try { res.json(await svc.setCollectionState(req.auth!, String(req.params.id), 'ACTIVE')); } catch (e) { next(e); }
});
