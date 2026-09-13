import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, zDate, zDecimal } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import * as svc from './reports.service.js';
import { dateOnly, monthKey, monthRange } from '../../lib/dates.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireCompany);

const periodOf = (q: Record<string, unknown>) => {
  const now = new Date();
  const { start } = monthRange(monthKey(now));
  const from = typeof q.from === 'string' && q.from ? dateOnly(q.from) : start;
  const to = typeof q.to === 'string' && q.to ? dateOnly(q.to) : dateOnly(now);
  return { from, to };
};

reportsRouter.get('/dashboard', requirePermission('reports.view'), async (req, res, next) => {
  try { const { from, to } = periodOf(req.query as Record<string, unknown>); res.json(await svc.dashboard(companyOf(req), from, to)); } catch (e) { next(e); }
});

reportsRouter.get('/receipts', requirePermission('reports.view'), async (req, res, next) => {
  try {
    const { from, to } = periodOf(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string | undefined>;
    const rows = await svc.receiptsExtract(companyOf(req), { from, to, clientId: q.clientId || undefined, loanId: q.loanId || undefined, userId: q.userId || undefined });
    if (q.format === 'xlsx') {
      if (!req.auth!.permissions.has('data.export') && req.auth!.role !== 'COMPANY_ADMIN') return res.status(403).json({ error: 'Sem permissão para exportar' });
      await audit(req.auth!, { action: 'EXPORT_RECEIPTS_XLSX', entity: 'Payment', after: { from, to, rows: rows.length } });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="recebimentos.xlsx"');
      return res.send(await svc.receiptsXlsx(rows));
    }
    res.json(rows);
  } catch (e) { next(e); }
});

reportsRouter.get('/monthly', requirePermission('reports.view'), async (req, res, next) => {
  try { res.json(await prisma.monthlyReport.findMany({ where: { companyId: companyOf(req) }, orderBy: [{ referenceMonth: 'desc' }, { version: 'desc' }], select: { id: true, referenceMonth: true, version: true, referenceDate: true, automatic: true, generatedById: true, createdAt: true } })); } catch (e) { next(e); }
});

reportsRouter.get('/monthly/preview', requirePermission('reports.view'), async (req, res, next) => {
  try {
    const month = z.string().regex(/^\d{4}-\d{2}$/).parse(String(req.query.month ?? monthKey(new Date())));
    const data = await svc.buildMonthlyReport(companyOf(req), month);
    const previous = (await svc.buildMonthlyReport(companyOf(req), (await import('../../lib/dates.js')).previousMonthKey(month))).totals;
    res.json({ ...data, previous, preview: true });
  } catch (e) { next(e); }
});

reportsRouter.post('/monthly/close', requirePermission('reports.view'), async (req, res, next) => {
  try {
    const body = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
    res.status(201).json(await svc.closeMonth(companyOf(req), body.month, req.auth!));
  } catch (e) { next(e); }
});

reportsRouter.get('/monthly/:id', requirePermission('reports.view'), async (req, res, next) => {
  try { const r = await svc.getReport(companyOf(req), String(req.params.id)); res.json({ id: r.id, version: r.version, referenceDate: r.referenceDate, automatic: r.automatic, ...(r.data as object) }); } catch (e) { next(e); }
});

reportsRouter.get('/monthly/:id/pdf', requirePermission('data.export'), async (req, res, next) => {
  try {
    const r = await svc.getReport(companyOf(req), String(req.params.id));
    const pdf = await svc.monthlyPdf(companyOf(req), r.data as never, { version: r.version, referenceDate: r.referenceDate });
    await audit(req.auth!, { action: 'EXPORT_MONTHLY_PDF', entity: 'MonthlyReport', entityId: r.id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="relatorio-${r.referenceMonth}-v${r.version}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

reportsRouter.get('/monthly/:id/xlsx', requirePermission('data.export'), async (req, res, next) => {
  try {
    const r = await svc.getReport(companyOf(req), String(req.params.id));
    await audit(req.auth!, { action: 'EXPORT_MONTHLY_XLSX', entity: 'MonthlyReport', entityId: r.id });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio-${r.referenceMonth}-v${r.version}.xlsx"`);
    res.send(await svc.monthlyXlsx(r.data as never, { version: r.version }));
  } catch (e) { next(e); }
});

// ---- Despesas ----
const expenseSchema = z.object({ date: zDate, description: z.string().min(2), category: z.string().default('GERAL'), amount: zDecimal });
reportsRouter.get('/expenses', requirePermission('reports.view'), async (req, res, next) => {
  try { const { from, to } = periodOf(req.query as Record<string, unknown>); res.json(await prisma.expense.findMany({ where: { companyId: companyOf(req), date: { gte: from, lte: to } }, orderBy: { date: 'desc' } })); } catch (e) { next(e); }
});
reportsRouter.post('/expenses', requirePermission('payments.register'), async (req, res, next) => {
  try {
    const d = parse(expenseSchema, req.body);
    const e = await prisma.expense.create({ data: { ...d, date: dateOnly(d.date), companyId: companyOf(req), createdById: req.auth!.userId } });
    await audit(req.auth!, { action: 'EXPENSE_CREATE', entity: 'Expense', entityId: e.id, after: e });
    res.status(201).json(e);
  } catch (e) { next(e); }
});
reportsRouter.delete('/expenses/:id', requirePermission('payments.register'), async (req, res, next) => {
  try {
    const e = await prisma.expense.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!e) throw notFound();
    await prisma.expense.delete({ where: { id: e.id } });
    await audit(req.auth!, { action: 'EXPENSE_DELETE', entity: 'Expense', entityId: e.id, before: e });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
