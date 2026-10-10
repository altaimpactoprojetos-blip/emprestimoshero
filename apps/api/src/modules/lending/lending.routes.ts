import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import * as svc from './lending.service.js';
import * as contract from './contract.js';
import * as exporter from './export.js';

/** Empréstimos sobre saldo devedor, dados do credor, painel e simulador. */
export const lendingRouter = Router();
lendingRouter.use(authenticate, requireCompany);

const q = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

// ---- Configurações (dados do credor e padrões de cálculo) ----
lendingRouter.get('/settings', async (req, res, next) => {
  try {
    const c = await prisma.company.findUniqueOrThrow({ where: { id: companyOf(req) }, select: { settings: true } });
    res.json(svc.readSettings(c.settings));
  } catch (e) { next(e); }
});
lendingRouter.put('/settings', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const body = parse(z.object({ creditor: svc.creditorSchema.optional(), lending: svc.lendingSettingsSchema.optional() }), req.body);
    const before = await prisma.company.findUniqueOrThrow({ where: { id: companyOf(req) } });
    const cur = svc.readSettings(before.settings);
    const creditor = { ...cur.creditor, ...(body.creditor ?? {}) };
    if (creditor.cpf) creditor.cpf = creditor.cpf.replace(/\D/g, '');
    const settings = { ...(before.settings as object), creditor, lending: { ...cur.lending, ...(body.lending ?? {}) } };
    const c = await prisma.company.update({ where: { id: before.id }, data: { settings } });
    await audit(req.auth!, { action: 'LENDING_SETTINGS_UPDATE', entity: 'Company', entityId: c.id, before: cur, after: svc.readSettings(c.settings) });
    res.json(svc.readSettings(c.settings));
  } catch (e) { next(e); }
});

// ---- Simulador e painel ----
lendingRouter.post('/simulate', requirePermission('loans.view'), async (req, res, next) => {
  try { res.json(await svc.simulate(companyOf(req), parse(svc.termsSchema, req.body))); } catch (e) { next(e); }
});
lendingRouter.get('/dashboard', requirePermission('loans.view'), async (req, res, next) => {
  try { res.json(await svc.lendingDashboard(companyOf(req), { clientId: q(req.query.clientId) })); } catch (e) { next(e); }
});

// ---- Empréstimos ----
lendingRouter.get('/loans', requirePermission('loans.view'), async (req, res, next) => {
  try { res.json(await svc.listBalanceLoans(companyOf(req), { clientId: q(req.query.clientId), status: q(req.query.status), q: q(req.query.q) })); } catch (e) { next(e); }
});
lendingRouter.post('/loans', requirePermission('loans.create'), async (req, res, next) => {
  try { res.status(201).json(await svc.createBalanceLoan(req.auth!, parse(svc.balanceLoanSchema, req.body))); } catch (e) { next(e); }
});
lendingRouter.get('/loans/:id', requirePermission('loans.view'), async (req, res, next) => {
  try { res.json(await svc.balanceLoanDetail(companyOf(req), String(req.params.id))); } catch (e) { next(e); }
});
lendingRouter.put('/loans/:id', requirePermission('loans.create'), async (req, res, next) => {
  try { res.json(await svc.updateBalanceLoan(req.auth!, String(req.params.id), parse(svc.balanceLoanSchema, req.body))); } catch (e) { next(e); }
});
lendingRouter.delete('/loans/:id', requirePermission('loans.approve'), async (req, res, next) => {
  try { await svc.deleteBalanceLoan(req.auth!, String(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Pagamentos ----
lendingRouter.post('/loans/:id/payments/preview', requirePermission('payments.register'), async (req, res, next) => {
  try { res.json(await svc.previewPayment(companyOf(req), String(req.params.id), parse(svc.balancePaymentSchema, req.body))); } catch (e) { next(e); }
});
lendingRouter.post('/loans/:id/payments', requirePermission('payments.register'), async (req, res, next) => {
  try { res.status(201).json(await svc.registerBalancePayment(req.auth!, String(req.params.id), parse(svc.balancePaymentSchema, req.body))); } catch (e) { next(e); }
});
lendingRouter.post('/payments/:id/preview', requirePermission('payments.reverse'), async (req, res, next) => {
  try {
    const p = await prisma.payment.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) }, select: { loanId: true } });
    if (!p) throw svc.notFoundPayment();
    res.json(await svc.previewPayment(companyOf(req), p.loanId, parse(svc.balancePaymentSchema, req.body), String(req.params.id)));
  } catch (e) { next(e); }
});
lendingRouter.put('/payments/:id', requirePermission('payments.reverse'), async (req, res, next) => {
  try { res.json(await svc.updateBalancePayment(req.auth!, String(req.params.id), parse(svc.balancePaymentSchema, req.body))); } catch (e) { next(e); }
});
lendingRouter.delete('/payments/:id', requirePermission('payments.reverse'), async (req, res, next) => {
  try { res.json(await svc.deleteBalancePayment(req.auth!, String(req.params.id))); } catch (e) { next(e); }
});

// ---- Contrato ----
lendingRouter.post('/loans/:id/contract/draft', requirePermission('loans.view'), async (req, res, next) => {
  try { res.json(await contract.contractDraft(companyOf(req), String(req.params.id), parse(contract.contractOptionsSchema, req.body ?? {}))); } catch (e) { next(e); }
});
lendingRouter.post('/loans/:id/contracts', requirePermission('contracts.manage'), async (req, res, next) => {
  try { res.status(201).json(await contract.saveContract(req.auth!, String(req.params.id), parse(z.object({ text: z.string().max(100_000) }), req.body).text)); } catch (e) { next(e); }
});
lendingRouter.post('/contracts/:id/signed', requirePermission('contracts.manage'), async (req, res, next) => {
  try { res.json(await contract.markContractSigned(req.auth!, String(req.params.id))); } catch (e) { next(e); }
});
lendingRouter.delete('/contracts/:id', requirePermission('contracts.manage'), async (req, res, next) => {
  try { await contract.deleteContract(req.auth!, String(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Exportação e backup ----
lendingRouter.get('/export.xlsx', requirePermission('reports.view'), async (req, res, next) => {
  try {
    const buf = await exporter.exportXlsx(companyOf(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="emprestimos-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buf);
  } catch (e) { next(e); }
});
lendingRouter.get('/export.csv', requirePermission('reports.view'), async (req, res, next) => {
  try {
    const kind = z.enum(['loans', 'payments', 'clients']).parse(req.query.kind ?? 'loans');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await exporter.exportCsv(companyOf(req), kind));
  } catch (e) { next(e); }
});
lendingRouter.get('/backup.json', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const data = await exporter.backupJson(companyOf(req));
    await audit(req.auth!, { action: 'BACKUP_DOWNLOAD', entity: 'Company', entityId: companyOf(req) });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (e) { next(e); }
});
