import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../../lib/prisma.js';
import { parse } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { readFile, storeFile } from '../../lib/storage.js';
import { mailerConfigured } from '../../services/mailer.js';
import { smsConfigured } from '../../services/sms.js';
import { config } from '../../config.js';

export const companyRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Identidade visual pública (usada na tela de login do portal), sem dados sensíveis. */
companyRouter.get('/public/:slug', async (req, res, next) => {
  try {
    const c = await prisma.company.findUnique({ where: { slug: String(req.params.slug) }, select: { id: true, name: true, slug: true, logoFileId: true, primaryColor: true, secondaryColor: true, status: true } });
    if (!c || c.status === 'SUSPENDED' || c.status === 'CANCELLED') throw notFound('Empresa não encontrada');
    res.json(c);
  } catch (e) { next(e); }
});

/** Logo público (imagem apenas). */
companyRouter.get('/public/:slug/logo', async (req, res, next) => {
  try {
    const c = await prisma.company.findUnique({ where: { slug: String(req.params.slug) }, select: { id: true, logoFileId: true } });
    if (!c?.logoFileId) throw notFound();
    const r = await readFile(c.id, c.logoFileId);
    if (!r) throw notFound();
    res.setHeader('Content-Type', r.file.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(r.data);
  } catch (e) { next(e); }
});

companyRouter.use(authenticate, requireCompany);

const settingsSchema = z.object({
  name: z.string().min(2).optional(),
  legalName: z.string().optional().nullable(),
  cnpj: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().optional(),
  settings: z.object({
    require2faForAdmins: z.boolean().optional(),
    paymentInstructions: z.string().optional(),
    pixKey: z.string().optional(),
    receiptFooter: z.string().optional(),
  }).partial().optional(),
});

companyRouter.get('/me', async (req, res, next) => {
  try {
    const c = await prisma.company.findUnique({ where: { id: companyOf(req) }, include: { plan: true, subscriptions: { where: { status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] } }, take: 1 } } });
    res.json({
      ...c,
      integrations: {
        email: mailerConfigured() ? 'smtp' : 'console',
        sms: smsConfigured() ? 'twilio' : 'console',
        payments: config.payments.provider,
        signature: config.signature.provider,
      },
    });
  } catch (e) { next(e); }
});

companyRouter.put('/me', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const data = parse(settingsSchema, req.body);
    const before = await prisma.company.findUniqueOrThrow({ where: { id: companyOf(req) } });
    const mergedSettings = { ...(before.settings as object), ...(data.settings ?? {}) };
    const c = await prisma.company.update({ where: { id: before.id }, data: { ...data, cnpj: data.cnpj ? data.cnpj.replace(/\D/g, '') : data.cnpj, settings: mergedSettings } });
    await audit(req.auth!, { action: 'COMPANY_SETTINGS_UPDATE', entity: 'Company', entityId: c.id, before, after: c });
    res.json(c);
  } catch (e) { next(e); }
});

companyRouter.post('/me/logo', requirePermission('settings.manage'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('Envie um arquivo de imagem');
    if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(req.file.mimetype)) throw badRequest('Formato de imagem não suportado');
    const f = await storeFile(companyOf(req), req.file.originalname, req.file.mimetype, req.file.buffer, req.auth!.userId);
    const c = await prisma.company.update({ where: { id: companyOf(req) }, data: { logoFileId: f.id } });
    await audit(req.auth!, { action: 'COMPANY_LOGO_UPDATE', entity: 'Company', entityId: c.id, after: { logoFileId: f.id } });
    res.json({ logoFileId: f.id });
  } catch (e) { next(e); }
});

/** Download de arquivo privado da empresa (documentos, contratos, comprovantes). */
companyRouter.get('/files/:id', async (req, res, next) => {
  try {
    const r = await readFile(companyOf(req), String(req.params.id));
    if (!r) throw notFound('Arquivo não encontrado');
    res.setHeader('Content-Type', r.file.mimeType);
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(r.file.filename)}"`);
    res.send(r.data);
  } catch (e) { next(e); }
});
