import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, zId } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import * as svc from './collections.service.js';
import { mailerConfigured } from '../../services/mailer.js';
import { smsConfigured } from '../../services/sms.js';

export const collectionsRouter = Router();
collectionsRouter.use(authenticate, requireCompany, requirePermission('collections.manage'));

collectionsRouter.get('/settings', async (req, res, next) => {
  try {
    const s = await svc.ensureDefaults(companyOf(req));
    res.json({ ...s, channels: { email: mailerConfigured() ? 'smtp' : 'console', sms: smsConfigured() ? 'twilio' : 'console' } });
  } catch (e) { next(e); }
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string(),
  sendHourStart: z.number().int().min(0).max(23),
  sendHourEnd: z.number().int().min(1).max(24),
  sendDays: z.array(z.number().int().min(0).max(6)).min(1),
  maxPerClientPerDay: z.number().int().min(1).max(20),
  steps: z.array(z.object({ offsetDays: z.number().int().min(-30).max(180), channels: z.array(z.enum(['EMAIL', 'SMS', 'PORTAL'])).min(1) })).min(1).max(12),
});

collectionsRouter.put('/settings', async (req, res, next) => {
  try {
    const data = parse(settingsSchema, req.body);
    if (data.sendHourEnd <= data.sendHourStart) throw new (await import('../../lib/errors.js')).AppError(400, 'Hora final deve ser maior que a inicial');
    const before = await svc.ensureDefaults(companyOf(req));
    const s = await prisma.collectionSettings.update({ where: { companyId: companyOf(req) }, data: { ...data, steps: data.steps as never } });
    await audit(req.auth!, { action: 'COLLECTION_SETTINGS_UPDATE', entity: 'CollectionSettings', entityId: s.id, before, after: s });
    res.json(s);
  } catch (e) { next(e); }
});

collectionsRouter.get('/templates', async (req, res, next) => {
  try {
    await svc.ensureDefaults(companyOf(req));
    res.json({ templates: await prisma.messageTemplate.findMany({ where: { companyId: companyOf(req) }, orderBy: [{ key: 'asc' }, { channel: 'asc' }] }), variables: ['nome', 'nome_completo', 'empresa', 'parcela', 'contrato', 'vencimento', 'valor', 'saldo', 'dias_atraso', 'link'] });
  } catch (e) { next(e); }
});

collectionsRouter.put('/templates/:id', async (req, res, next) => {
  try {
    const body = parse(z.object({ subject: z.string().optional().nullable(), body: z.string().min(5) }), req.body);
    const before = await prisma.messageTemplate.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!before) throw notFound();
    if (before.channel === 'SMS' && body.body.length > 320) throw new (await import('../../lib/errors.js')).AppError(400, 'Mensagem SMS deve ter até 320 caracteres');
    const t = await prisma.messageTemplate.update({ where: { id: before.id }, data: body });
    await audit(req.auth!, { action: 'MESSAGE_TEMPLATE_UPDATE', entity: 'MessageTemplate', entityId: t.id, before, after: t });
    res.json(t);
  } catch (e) { next(e); }
});

collectionsRouter.get('/reminders', async (req, res, next) => {
  try {
    const { status, channel, from, to, clientId } = req.query as Record<string, string | undefined>;
    const items = await prisma.reminder.findMany({
      where: { companyId: companyOf(req), ...(status ? { status: status as never } : {}), ...(channel ? { channel: channel as never } : {}), ...(clientId ? { clientId } : {}), ...(from || to ? { scheduledFor: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59Z`) } : {}) } } : {}) },
      orderBy: { scheduledFor: 'desc' },
      include: { client: { select: { id: true, name: true } }, installment: { select: { number: true, dueDate: true, loanId: true, loan: { select: { number: true } } } }, attemptsLog: { orderBy: { number: 'asc' } } },
      take: 1000,
    });
    res.json(items);
  } catch (e) { next(e); }
});

collectionsRouter.get('/summary', async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86400000);
    const [scheduled, sent24h, failed, issues] = await Promise.all([
      prisma.reminder.count({ where: { companyId, status: 'SCHEDULED' } }),
      prisma.reminder.count({ where: { companyId, status: 'SENT', sentAt: { gte: dayAgo } } }),
      prisma.reminder.count({ where: { companyId, status: 'FAILED' } }),
      prisma.integrationIssue.count({ where: { companyId, resolvedAt: null } }),
    ]);
    res.json({ scheduled, sent24h, failed, issues });
  } catch (e) { next(e); }
});

collectionsRouter.post('/reminders/:id/cancel', async (req, res, next) => {
  try {
    const r = await prisma.reminder.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!r) throw notFound();
    const u = await prisma.reminder.update({ where: { id: r.id }, data: { status: 'CANCELLED', cancelReason: `Cancelado manualmente por ${req.auth!.userName}` } });
    await audit(req.auth!, { action: 'REMINDER_CANCEL', entity: 'Reminder', entityId: r.id });
    res.json(u);
  } catch (e) { next(e); }
});

collectionsRouter.post('/send', async (req, res, next) => {
  try {
    const body = parse(z.object({ installmentId: zId, channel: z.enum(['EMAIL', 'SMS', 'PORTAL']) }), req.body);
    res.json(await svc.sendManualReminder(req.auth!, body.installmentId, body.channel));
  } catch (e) { next(e); }
});

/** Executa agora o ciclo (agendar + disparar) para a empresa — útil para demonstração e verificação. */
collectionsRouter.post('/run', async (req, res, next) => {
  try {
    const r = await svc.runCollectionsFor(companyOf(req));
    await audit(req.auth!, { action: 'COLLECTIONS_RUN_MANUAL', entity: 'CollectionSettings', after: r });
    res.json(r);
  } catch (e) { next(e); }
});

collectionsRouter.get('/issues', async (req, res, next) => {
  try { res.json(await prisma.integrationIssue.findMany({ where: { companyId: companyOf(req), ...(req.query.all ? {} : { resolvedAt: null }) }, orderBy: { createdAt: 'desc' }, take: 300 })); } catch (e) { next(e); }
});
collectionsRouter.post('/issues/:id/resolve', async (req, res, next) => {
  try {
    const i = await prisma.integrationIssue.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!i) throw notFound();
    res.json(await prisma.integrationIssue.update({ where: { id: i.id }, data: { resolvedAt: new Date(), resolvedById: req.auth!.userId } }));
  } catch (e) { next(e); }
});
