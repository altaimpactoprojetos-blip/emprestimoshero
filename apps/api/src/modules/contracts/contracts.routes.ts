import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, zId } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import * as svc from './contracts.service.js';
import { TEMPLATE_PLACEHOLDERS } from '../../domain/template.js';
import { readFile } from '../../lib/storage.js';
import { config } from '../../config.js';

export const contractsRouter = Router();
contractsRouter.use(authenticate, requireCompany);

// ---- Modelos ----
contractsRouter.get('/templates', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    await svc.ensureDefaultTemplate(companyOf(req));
    res.json({ placeholders: TEMPLATE_PLACEHOLDERS, templates: await prisma.contractTemplate.findMany({ where: { companyId: companyOf(req) }, orderBy: [{ name: 'asc' }, { version: 'desc' }] }) });
  } catch (e) { next(e); }
});

const templateSchema = z.object({ name: z.string().min(2), content: z.string().min(20), legalReviewNotes: z.string().optional().nullable() });

contractsRouter.post('/templates', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const data = parse(templateSchema, req.body);
    const t = await prisma.contractTemplate.create({ data: { ...data, companyId: companyOf(req) } });
    await audit(req.auth!, { action: 'TEMPLATE_CREATE', entity: 'ContractTemplate', entityId: t.id, after: { name: t.name, version: t.version } });
    res.status(201).json(t);
  } catch (e) { next(e); }
});

/** Editar: rascunho é alterado no lugar; modelo aprovado gera nova versão em rascunho (versionamento). */
contractsRouter.put('/templates/:id', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const before = await prisma.contractTemplate.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!before) throw notFound();
    const data = parse(templateSchema.partial(), req.body);
    let t;
    if (before.status === 'DRAFT') t = await prisma.contractTemplate.update({ where: { id: before.id }, data });
    else {
      const maxVersion = await prisma.contractTemplate.aggregate({ where: { companyId: before.companyId, name: data.name ?? before.name }, _max: { version: true } });
      t = await prisma.contractTemplate.create({ data: { companyId: before.companyId, name: data.name ?? before.name, content: data.content ?? before.content, legalReviewNotes: data.legalReviewNotes ?? null, version: (maxVersion._max.version ?? before.version) + 1, status: 'DRAFT' } });
    }
    await audit(req.auth!, { action: 'TEMPLATE_UPDATE', entity: 'ContractTemplate', entityId: t.id, before: { version: before.version, status: before.status }, after: { version: t.version, status: t.status } });
    res.json(t);
  } catch (e) { next(e); }
});

contractsRouter.post('/templates/:id/approve', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const t = await prisma.contractTemplate.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!t) throw notFound();
    const body = parse(z.object({ legalReviewNotes: z.string().min(5, 'Registre a revisão jurídica realizada') }), req.body);
    await prisma.$transaction([
      prisma.contractTemplate.updateMany({ where: { companyId: t.companyId, name: t.name, status: 'APPROVED', id: { not: t.id } }, data: { status: 'ARCHIVED' } }),
      prisma.contractTemplate.update({ where: { id: t.id }, data: { status: 'APPROVED', approvedById: req.auth!.userId, approvedAt: new Date(), legalReviewNotes: body.legalReviewNotes } }),
    ]);
    await audit(req.auth!, { action: 'TEMPLATE_APPROVE', entity: 'ContractTemplate', entityId: t.id, after: { version: t.version, legalReviewNotes: body.legalReviewNotes } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

contractsRouter.post('/templates/:id/archive', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const t = await prisma.contractTemplate.updateMany({ where: { id: String(req.params.id), companyId: companyOf(req) }, data: { status: 'ARCHIVED' } });
    if (!t.count) throw notFound();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

contractsRouter.post('/templates/preview', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const body = parse(z.object({ content: z.string(), loanId: zId.optional() }), req.body);
    res.json({ html: await svc.previewTemplate(companyOf(req), body.content, body.loanId) });
  } catch (e) { next(e); }
});

// ---- Contratos ----
contractsRouter.get('/', requirePermission('loans.view'), async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    res.json(await prisma.contract.findMany({ where: { companyId: companyOf(req), ...(status ? { status: status as never } : {}) }, orderBy: { createdAt: 'desc' }, include: { loan: { select: { id: true, number: true, principalAmount: true, client: { select: { id: true, name: true, document: true } } } }, signers: true }, take: 1000 }));
  } catch (e) { next(e); }
});

contractsRouter.post('/generate', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const body = parse(z.object({ loanId: zId, templateId: zId, kind: z.enum(['CONTRACT', 'ADDENDUM']).default('CONTRACT'), parentContractId: zId.optional(), extraText: z.string().optional() }), req.body);
    res.status(201).json(await svc.generateContract(req.auth!, body.loanId, body.templateId, body));
  } catch (e) { next(e); }
});

contractsRouter.get('/:id', requirePermission('loans.view'), async (req, res, next) => {
  try {
    const c = await prisma.contract.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) }, include: { signers: true, loan: { select: { id: true, number: true, status: true, client: { select: { name: true } } } }, template: { select: { name: true, version: true } }, addenda: true, parentContract: { select: { id: true, version: true } } } });
    if (!c) throw notFound('Contrato não encontrado');
    res.json({ ...c, html: await svc.contractHtml(companyOf(req), c.id), signatureSimulationAvailable: config.signature.provider === 'mock' });
  } catch (e) { next(e); }
});

contractsRouter.get('/:id/pdf', requirePermission('loans.view'), async (req, res, next) => {
  try {
    const c = await prisma.contract.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!c?.fileId) throw notFound('PDF não disponível');
    const f = await readFile(companyOf(req), c.fileId);
    if (!f) throw notFound();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${f.file.filename}"`);
    res.send(f.data);
  } catch (e) { next(e); }
});

for (const action of ['review', 'request_signature', 'cancel', 'back_to_draft'] as const) {
  contractsRouter.post(`/:id/${action}`, requirePermission('contracts.manage'), async (req, res, next) => {
    try { res.json(await svc.changeStatus(req.auth!, String(req.params.id), action, req.body?.reason)); } catch (e) { next(e); }
  });
}

/** Simulação de assinatura (apenas com provedor mock, para demonstração). */
contractsRouter.post('/:id/simulate-signature', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    if (config.signature.provider !== 'mock') throw badRequest('Simulação disponível apenas com o provedor de demonstração');
    const c = await prisma.contract.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req) } });
    if (!c) throw notFound();
    res.json(await svc.markSigned(c.id, { provider: 'mock', documentHash: c.sha256 ?? undefined, signers: [{ role: 'BORROWER', ip: req.ip, evidence: { method: 'simulação', userAgent: req.headers['user-agent'] } }, { role: 'LENDER', ip: req.ip, evidence: { method: 'simulação' } }] }, req.auth!));
  } catch (e) { next(e); }
});
