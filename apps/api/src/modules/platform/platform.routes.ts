import { Router } from 'express';
import { z } from 'zod';
import { addMonths } from 'date-fns';
import { prisma } from '../../lib/prisma.js';
import { parse, zDecimal, zId } from '../../lib/validate.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { hashPassword, validatePasswordStrength } from '../auth/auth.service.js';
import { D, cents } from '../../lib/money.js';
import { monthKey } from '../../lib/dates.js';

/**
 * Painel exclusivo do proprietário da plataforma.
 * Gerencia empresas, planos, assinaturas e faturas do software — separado do financeiro dos empréstimos.
 */
export const platformRouter = Router();
platformRouter.use(authenticate, requireRole('PLATFORM_OWNER'));

const planSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional().nullable(),
  monthlyPrice: zDecimal,
  maxUsers: z.number().int().min(1),
  maxClients: z.number().int().min(1).optional().nullable(),
  features: z.record(z.string(), z.boolean()).default({}),
  active: z.boolean().default(true),
});

platformRouter.get('/overview', async (_req, res, next) => {
  try {
    const [companies, activeCompanies, plans, openInvoices, overdueInvoices, paidThisMonth] = await Promise.all([
      prisma.company.count(),
      prisma.company.count({ where: { status: 'ACTIVE' } }),
      prisma.plan.count({ where: { active: true } }),
      prisma.subscriptionInvoice.aggregate({ where: { status: 'OPEN' }, _sum: { amount: true }, _count: true }),
      prisma.subscriptionInvoice.aggregate({ where: { status: 'OVERDUE' }, _sum: { amount: true }, _count: true }),
      prisma.subscriptionInvoice.aggregate({ where: { status: 'PAID', referenceMonth: monthKey(new Date()) }, _sum: { amount: true } }),
    ]);
    const mrr = await prisma.subscription.aggregate({ where: { status: { in: ['ACTIVE', 'TRIAL'] } }, _sum: { monthlyPrice: true } });
    res.json({
      companies, activeCompanies, plans,
      mrr: mrr._sum.monthlyPrice ?? 0,
      openInvoices: { count: openInvoices._count, amount: openInvoices._sum.amount ?? 0 },
      overdueInvoices: { count: overdueInvoices._count, amount: overdueInvoices._sum.amount ?? 0 },
      paidThisMonth: paidThisMonth._sum.amount ?? 0,
    });
  } catch (e) { next(e); }
});

// ---- Planos ----
platformRouter.get('/plans', async (_req, res, next) => {
  try { res.json(await prisma.plan.findMany({ orderBy: { monthlyPrice: 'asc' }, include: { _count: { select: { companies: true } } } })); } catch (e) { next(e); }
});
platformRouter.post('/plans', async (req, res, next) => {
  try {
    const data = parse(planSchema, req.body);
    const plan = await prisma.plan.create({ data: { ...data, monthlyPrice: data.monthlyPrice } });
    await audit(req.auth!, { action: 'PLAN_CREATE', entity: 'Plan', entityId: plan.id, after: plan });
    res.status(201).json(plan);
  } catch (e) { next(e); }
});
platformRouter.put('/plans/:id', async (req, res, next) => {
  try {
    const data = parse(planSchema.partial(), req.body);
    const before = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
    if (!before) throw notFound();
    const plan = await prisma.plan.update({ where: { id: String(req.params.id) }, data });
    await audit(req.auth!, { action: 'PLAN_UPDATE', entity: 'Plan', entityId: plan.id, before, after: plan });
    res.json(plan);
  } catch (e) { next(e); }
});

// ---- Empresas ----
const companySchema = z.object({
  name: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'Use letras minúsculas, números e hífen'),
  legalName: z.string().optional().nullable(),
  cnpj: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  planId: zId.optional().nullable(),
  status: z.enum(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED']).optional(),
  timezone: z.string().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  admin: z.object({ name: z.string().min(2), email: z.string().email(), password: z.string() }).optional(),
});

platformRouter.get('/companies', async (_req, res, next) => {
  try {
    const list = await prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: { plan: true, _count: { select: { users: true, clients: true, loans: true } }, subscriptions: { where: { status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] } }, take: 1, orderBy: { createdAt: 'desc' } } },
    });
    res.json(list);
  } catch (e) { next(e); }
});

platformRouter.get('/companies/:id', async (req, res, next) => {
  try {
    const c = await prisma.company.findUnique({
      where: { id: String(req.params.id) },
      include: { plan: true, users: { where: { role: { not: 'CLIENT' } }, select: { id: true, name: true, email: true, role: true, active: true, twoFactorEnabled: true, lastLoginAt: true } }, subscriptions: { orderBy: { createdAt: 'desc' }, include: { plan: true } }, subscriptionInvoices: { orderBy: { dueDate: 'desc' } }, _count: { select: { clients: true, loans: true } } },
    });
    if (!c) throw notFound('Empresa não encontrada');
    res.json(c);
  } catch (e) { next(e); }
});

platformRouter.post('/companies', async (req, res, next) => {
  try {
    const data = parse(companySchema, req.body);
    const { admin, planId, ...rest } = data;
    if (admin) validatePasswordStrength(admin.password);
    const company = await prisma.$transaction(async (tx) => {
      const c = await tx.company.create({ data: { ...rest, planId: planId ?? null, cnpj: rest.cnpj ? rest.cnpj.replace(/\D/g, '') : null } });
      if (planId) {
        const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
        await tx.subscription.create({
          data: { companyId: c.id, planId, status: c.status === 'TRIAL' ? 'TRIAL' : 'ACTIVE', monthlyPrice: plan.monthlyPrice, maxUsers: plan.maxUsers, features: plan.features as never, currentPeriodStart: new Date(), currentPeriodEnd: addMonths(new Date(), 1) },
        });
      }
      if (admin) {
        await tx.user.create({ data: { companyId: c.id, name: admin.name, email: admin.email.toLowerCase(), passwordHash: await hashPassword(admin.password), role: 'COMPANY_ADMIN', mustChangePassword: true } });
      }
      await tx.collectionSettings.create({ data: { companyId: c.id, timezone: rest.timezone ?? 'America/Sao_Paulo' } });
      return c;
    });
    await audit(req.auth!, { action: 'COMPANY_CREATE', entity: 'Company', entityId: company.id, after: company });
    res.status(201).json(company);
  } catch (e) { next(e); }
});

platformRouter.put('/companies/:id', async (req, res, next) => {
  try {
    const data = parse(companySchema.partial().omit({ admin: true }), req.body);
    const before = await prisma.company.findUnique({ where: { id: String(req.params.id) } });
    if (!before) throw notFound('Empresa não encontrada');
    const company = await prisma.$transaction(async (tx) => {
      const c = await tx.company.update({ where: { id: String(req.params.id) }, data: { ...data, cnpj: data.cnpj ? data.cnpj.replace(/\D/g, '') : data.cnpj } });
      if (data.planId && data.planId !== before.planId) {
        const plan = await tx.plan.findUniqueOrThrow({ where: { id: data.planId } });
        await tx.subscription.updateMany({ where: { companyId: c.id, status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        await tx.subscription.create({ data: { companyId: c.id, planId: plan.id, status: 'ACTIVE', monthlyPrice: plan.monthlyPrice, maxUsers: plan.maxUsers, features: plan.features as never, currentPeriodStart: new Date(), currentPeriodEnd: addMonths(new Date(), 1) } });
      }
      return c;
    });
    await audit(req.auth!, { action: 'COMPANY_UPDATE', entity: 'Company', entityId: company.id, before, after: company });
    res.json(company);
  } catch (e) { next(e); }
});

/** Cria (ou redefine) o administrador inicial de uma empresa. */
platformRouter.post('/companies/:id/admin', async (req, res, next) => {
  try {
    const body = parse(z.object({ name: z.string().min(2), email: z.string().email(), password: z.string() }), req.body);
    validatePasswordStrength(body.password);
    const company = await prisma.company.findUnique({ where: { id: String(req.params.id) } });
    if (!company) throw notFound('Empresa não encontrada');
    const user = await prisma.user.upsert({
      where: { companyId_email: { companyId: company.id, email: body.email.toLowerCase() } },
      create: { companyId: company.id, name: body.name, email: body.email.toLowerCase(), passwordHash: await hashPassword(body.password), role: 'COMPANY_ADMIN', mustChangePassword: true },
      update: { name: body.name, passwordHash: await hashPassword(body.password), role: 'COMPANY_ADMIN', active: true, mustChangePassword: true },
    });
    await audit(req.auth!, { action: 'COMPANY_ADMIN_SET', entity: 'User', entityId: user.id, after: { email: user.email, companyId: company.id } });
    res.status(201).json({ id: user.id, email: user.email });
  } catch (e) { next(e); }
});

// ---- Faturas das assinaturas (financeiro do software) ----
platformRouter.get('/invoices', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const list = await prisma.subscriptionInvoice.findMany({ where: status ? { status: status as never } : undefined, orderBy: { dueDate: 'desc' }, include: { company: { select: { id: true, name: true } } }, take: 500 });
    res.json(list);
  } catch (e) { next(e); }
});

/** Gera as faturas do mês de referência para todas as assinaturas ativas (idempotente). */
platformRouter.post('/invoices/generate', async (req, res, next) => {
  try {
    const body = parse(z.object({ referenceMonth: z.string().regex(/^\d{4}-\d{2}$/), dueDay: z.number().int().min(1).max(28).default(10) }), req.body);
    const subs = await prisma.subscription.findMany({ where: { status: { in: ['ACTIVE', 'PAST_DUE', 'TRIAL'] }, monthlyPrice: { gt: 0 } } });
    const [y, m] = body.referenceMonth.split('-').map(Number);
    let created = 0;
    for (const s of subs) {
      const r = await prisma.subscriptionInvoice.createMany({
        data: [{ subscriptionId: s.id, companyId: s.companyId, referenceMonth: body.referenceMonth, amount: s.monthlyPrice, dueDate: new Date(Date.UTC(y, m - 1, body.dueDay)) }],
        skipDuplicates: true,
      });
      created += r.count;
    }
    await audit(req.auth!, { action: 'INVOICES_GENERATE', entity: 'SubscriptionInvoice', after: { referenceMonth: body.referenceMonth, created } });
    res.json({ created });
  } catch (e) { next(e); }
});

platformRouter.post('/invoices/:id/pay', async (req, res, next) => {
  try {
    const inv = await prisma.subscriptionInvoice.findUnique({ where: { id: String(req.params.id) } });
    if (!inv) throw notFound();
    if (inv.status === 'PAID') throw badRequest('Fatura já paga');
    const paid = await prisma.subscriptionInvoice.update({ where: { id: inv.id }, data: { status: 'PAID', paidAt: new Date(), notes: req.body?.notes ?? null } });
    await prisma.subscription.update({ where: { id: inv.subscriptionId }, data: { status: 'ACTIVE' } });
    await audit(req.auth!, { action: 'INVOICE_PAID', entity: 'SubscriptionInvoice', entityId: inv.id, before: inv, after: paid });
    res.json(paid);
  } catch (e) { next(e); }
});

platformRouter.post('/invoices/:id/cancel', async (req, res, next) => {
  try {
    const inv = await prisma.subscriptionInvoice.update({ where: { id: String(req.params.id) }, data: { status: 'CANCELLED' } });
    await audit(req.auth!, { action: 'INVOICE_CANCELLED', entity: 'SubscriptionInvoice', entityId: inv.id });
    res.json(inv);
  } catch (e) { next(e); }
});

platformRouter.get('/audit', async (req, res, next) => {
  try {
    const list = await prisma.auditLog.findMany({ where: { companyId: null }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(list);
  } catch (e) { next(e); }
});

export const _internal = { D, cents };
