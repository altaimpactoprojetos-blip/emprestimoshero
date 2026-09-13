import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../../lib/prisma.js';
import { parse, isValidCPF, isValidCNPJ, onlyDigits, zDate } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { storeFile } from '../../lib/storage.js';
import { hashPassword, validatePasswordStrength } from '../auth/auth.service.js';
import { computeBalance } from '../../domain/installment.js';
import { todayIn } from '../../lib/dates.js';
import { D, sum, type Dec } from '../../lib/money.js';
import { dateOnly } from '../../lib/dates.js';

export const clientsRouter = Router();
clientsRouter.use(authenticate, requireCompany);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const clientSchema = z.object({
  personType: z.enum(['PF', 'PJ']).default('PF'),
  name: z.string().min(3),
  document: z.string().min(11),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  birthDate: zDate.optional().nullable().or(z.literal('')),
  addressStreet: z.string().optional().nullable(),
  addressNumber: z.string().optional().nullable(),
  addressComplement: z.string().optional().nullable(),
  addressDistrict: z.string().optional().nullable(),
  addressCity: z.string().optional().nullable(),
  addressState: z.string().max(2).optional().nullable(),
  addressZip: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'INACTIVE']).optional(),
  contactPreferences: z.object({ email: z.boolean(), sms: z.boolean(), portal: z.boolean() }).partial().optional(),
});

function normalize(data: z.infer<typeof clientSchema>) {
  const document = onlyDigits(data.document);
  if (data.personType === 'PF' && !isValidCPF(document)) throw badRequest('CPF inválido');
  if (data.personType === 'PJ' && !isValidCNPJ(document)) throw badRequest('CNPJ inválido');
  return {
    ...data,
    document,
    email: data.email ? data.email.toLowerCase().trim() : null,
    phone: data.phone ? onlyDigits(data.phone) : null,
    birthDate: data.birthDate ? dateOnly(data.birthDate) : null,
    contactPreferences: { email: true, sms: true, portal: true, ...(data.contactPreferences ?? {}) },
  };
}

clientsRouter.get('/', requirePermission('clients.view'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const clients = await prisma.client.findMany({
      where: {
        companyId,
        ...(status ? { status: status as never } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { document: { contains: onlyDigits(q) || '§' } }, { email: { contains: q, mode: 'insensitive' } }, { phone: { contains: onlyDigits(q) || '§' } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: 1000,
      include: { _count: { select: { loans: true } } },
    });
    // resumo financeiro por cliente (saldo e atraso)
    const today = todayIn(req.auth!.companyId ? (await prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }))!.timezone : 'America/Sao_Paulo');
    const inst = await prisma.installment.findMany({ where: { companyId, status: { in: ['PENDING', 'PARTIAL'] }, loan: { status: 'ACTIVE', clientId: { in: clients.map((c) => c.id) } } }, include: { loan: { select: { clientId: true, lateFineRate: true, lateInterestMonthly: true } } } });
    const byClient = new Map<string, { open: Dec; overdue: Dec; maxDaysLate: number }>();
    for (const i of inst) {
      const b = computeBalance(i, i.loan, today);
      const cur = byClient.get(i.loan.clientId) ?? { open: D(0), overdue: D(0), maxDaysLate: 0 };
      cur.open = cur.open.plus(b.totalDue);
      if (b.daysLate > 0) { cur.overdue = cur.overdue.plus(b.totalDue); cur.maxDaysLate = Math.max(cur.maxDaysLate, b.daysLate); }
      byClient.set(i.loan.clientId, cur);
    }
    res.json(clients.map((c) => ({ ...c, summary: { openBalance: (byClient.get(c.id)?.open ?? D(0)).toFixed(2), overdueBalance: (byClient.get(c.id)?.overdue ?? D(0)).toFixed(2), maxDaysLate: byClient.get(c.id)?.maxDaysLate ?? 0, loans: c._count.loans } })));
  } catch (e) { next(e); }
});

/** Verificação de duplicidade antes do cadastro. */
clientsRouter.get('/check-document', requirePermission('clients.view'), async (req, res, next) => {
  try {
    const doc = onlyDigits(String(req.query.document ?? ''));
    const existing = doc ? await prisma.client.findUnique({ where: { companyId_document: { companyId: companyOf(req), document: doc } }, select: { id: true, name: true } }) : null;
    res.json({ exists: !!existing, client: existing });
  } catch (e) { next(e); }
});

clientsRouter.post('/', requirePermission('clients.manage'), async (req, res, next) => {
  try {
    const data = normalize(parse(clientSchema, req.body));
    const companyId = companyOf(req);
    const dup = await prisma.client.findUnique({ where: { companyId_document: { companyId, document: data.document } } });
    if (dup) throw conflict(`Já existe um cliente com este ${data.personType === 'PF' ? 'CPF' : 'CNPJ'}: ${dup.name}`);
    const client = await prisma.client.create({ data: { ...data, companyId, createdById: req.auth!.userId } });
    await audit(req.auth!, { action: 'CLIENT_CREATE', entity: 'Client', entityId: client.id, after: client });
    res.status(201).json(client);
  } catch (e) { next(e); }
});

clientsRouter.get('/:id', requirePermission('clients.view'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const client = await prisma.client.findFirst({
      where: { id: String(req.params.id), companyId },
      include: {
        documents: { include: { file: true }, orderBy: { createdAt: 'desc' } },
        user: { select: { id: true, email: true, active: true, lastLoginAt: true } },
        loans: { orderBy: { createdAt: 'desc' }, include: { installments: { orderBy: { number: 'asc' } }, contracts: { select: { id: true, status: true, version: true, kind: true, signedAt: true }, orderBy: { createdAt: 'desc' } } } },
        serviceRequests: { orderBy: { createdAt: 'desc' } },
        reminders: { orderBy: { createdAt: 'desc' }, take: 100, include: { installment: { select: { number: true, dueDate: true, loanId: true } } } },
        notifications: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!client) throw notFound('Cliente não encontrado');
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true } });
    const today = todayIn(company.timezone);
    const payments = await prisma.payment.findMany({ where: { clientId: client.id, companyId }, orderBy: { paidAt: 'desc' }, include: { installment: { select: { number: true } }, loan: { select: { number: true } } } });
    const loans = client.loans.map((l) => {
      const balances = l.installments.map((i) => ({ ...i, balance: computeBalance(i, l, today) }));
      const open = l.status === 'ACTIVE' ? sum(balances.map((b) => b.balance.totalDue)) : D(0);
      const overdue = l.status === 'ACTIVE' ? sum(balances.filter((b) => b.balance.daysLate > 0).map((b) => b.balance.totalDue)) : D(0);
      const maxDaysLate = Math.max(0, ...balances.map((b) => b.balance.daysLate));
      return { ...l, installments: balances.map((b) => ({ ...b, balance: serializeBalance(b.balance) })), summary: { openBalance: open.toFixed(2), overdueBalance: overdue.toFixed(2), maxDaysLate, paidInstallments: l.installments.filter((i) => i.status === 'PAID').length } };
    });
    const totals = {
      openBalance: sum(loans.map((l) => l.summary.openBalance)).toFixed(2),
      overdueBalance: sum(loans.map((l) => l.summary.overdueBalance)).toFixed(2),
      maxDaysLate: Math.max(0, ...loans.map((l) => l.summary.maxDaysLate)),
      activeLoans: loans.filter((l) => l.status === 'ACTIVE').length,
      totalPaid: sum(payments.filter((p) => p.status === 'CONFIRMED').map((p) => p.amount)).toFixed(2),
    };
    res.json({ ...client, loans, payments, totals });
  } catch (e) { next(e); }
});

export function serializeBalance(b: ReturnType<typeof computeBalance>) {
  return { principalOpen: b.principalOpen.toFixed(2), interestOpen: b.interestOpen.toFixed(2), openBase: b.openBase.toFixed(2), daysLate: b.daysLate, fine: b.fine.toFixed(2), lateInterest: b.lateInterest.toFixed(2), chargesCarried: b.chargesCarried.toFixed(2), chargesDue: b.chargesDue.toFixed(2), totalDue: b.totalDue.toFixed(2), displayStatus: b.displayStatus };
}

clientsRouter.put('/:id', requirePermission('clients.manage'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const before = await prisma.client.findFirst({ where: { id: String(req.params.id), companyId } });
    if (!before) throw notFound('Cliente não encontrado');
    const data = normalize(parse(clientSchema, { ...before, ...req.body, birthDate: req.body.birthDate ?? (before.birthDate ? before.birthDate.toISOString().slice(0, 10) : null) }));
    if (data.document !== before.document) {
      const dup = await prisma.client.findUnique({ where: { companyId_document: { companyId, document: data.document } } });
      if (dup) throw conflict(`Já existe um cliente com este documento: ${dup.name}`);
    }
    const client = await prisma.client.update({ where: { id: before.id }, data });
    await audit(req.auth!, { action: 'CLIENT_UPDATE', entity: 'Client', entityId: client.id, before, after: client });
    res.json(client);
  } catch (e) { next(e); }
});

clientsRouter.post('/:id/documents', requirePermission('clients.manage'), upload.single('file'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const client = await prisma.client.findFirst({ where: { id: String(req.params.id), companyId } });
    if (!client) throw notFound('Cliente não encontrado');
    if (!req.file) throw badRequest('Envie um arquivo');
    const type = z.enum(['RG', 'CPF', 'CNH', 'COMPROVANTE_RESIDENCIA', 'COMPROVANTE_RENDA', 'CONTRATO_SOCIAL', 'OUTRO']).parse(req.body.type ?? 'OUTRO');
    const file = await storeFile(companyId, req.file.originalname, req.file.mimetype, req.file.buffer, req.auth!.userId);
    const doc = await prisma.clientDocument.create({ data: { companyId, clientId: client.id, type, fileId: file.id }, include: { file: true } });
    await audit(req.auth!, { action: 'CLIENT_DOCUMENT_UPLOAD', entity: 'Client', entityId: client.id, after: { type, fileId: file.id, filename: file.filename } });
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

/** Cria ou redefine o acesso do cliente ao portal. */
clientsRouter.post('/:id/portal-access', requirePermission('clients.manage'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const client = await prisma.client.findFirst({ where: { id: String(req.params.id), companyId } });
    if (!client) throw notFound('Cliente não encontrado');
    const body = parse(z.object({ password: z.string(), email: z.string().email().optional() }), req.body);
    validatePasswordStrength(body.password);
    const email = (body.email ?? client.email ?? `${client.document}@portal.local`).toLowerCase();
    const user = await prisma.user.upsert({
      where: { clientId: client.id },
      create: { companyId, clientId: client.id, name: client.name, email, role: 'CLIENT', passwordHash: await hashPassword(body.password), mustChangePassword: true },
      update: { email, passwordHash: await hashPassword(body.password), active: true, mustChangePassword: true },
    });
    await audit(req.auth!, { action: 'CLIENT_PORTAL_ACCESS', entity: 'Client', entityId: client.id, after: { userId: user.id, email } });
    res.json({ id: user.id, email: user.email });
  } catch (e) { next(e); }
});

clientsRouter.put('/:id/service-requests/:reqId', requirePermission('clients.manage'), async (req, res, next) => {
  try {
    const body = parse(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED']), response: z.string().optional() }), req.body);
    const sr = await prisma.serviceRequest.findFirst({ where: { id: String(req.params.reqId), clientId: String(req.params.id), companyId: companyOf(req) } });
    if (!sr) throw notFound();
    const updated = await prisma.serviceRequest.update({ where: { id: sr.id }, data: { status: body.status, response: body.response ?? sr.response, handledById: req.auth!.userId } });
    if (body.response) await prisma.notification.create({ data: { companyId: sr.companyId, clientId: sr.clientId, title: 'Resposta ao seu atendimento', body: body.response, link: '/atendimento' } });
    await audit(req.auth!, { action: 'SERVICE_REQUEST_UPDATE', entity: 'ServiceRequest', entityId: sr.id, before: sr, after: updated });
    res.json(updated);
  } catch (e) { next(e); }
});
