import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse } from '../../lib/validate.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound, forbidden } from '../../lib/errors.js';
import { hashPassword, validatePasswordStrength } from '../auth/auth.service.js';
import { PERMISSIONS, PERMISSION_LABELS, DEFAULT_ROLE_PERMISSIONS, ROLE_LABELS } from '../../lib/permissions.js';

export const usersRouter = Router();
usersRouter.use(authenticate, requireCompany);

const STAFF = ['COMPANY_ADMIN', 'FINANCE', 'COLLECTION'] as const;
const userSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(STAFF),
  password: z.string().optional(),
  active: z.boolean().optional(),
  permissionGrants: z.array(z.enum(PERMISSIONS)).optional(),
  permissionDenies: z.array(z.enum(PERMISSIONS)).optional(),
});

const select = { id: true, name: true, email: true, role: true, active: true, twoFactorEnabled: true, lastLoginAt: true, permissionGrants: true, permissionDenies: true, createdAt: true };

usersRouter.get('/', requirePermission('users.manage'), async (req, res, next) => {
  try {
    res.json(await prisma.user.findMany({ where: { companyId: companyOf(req), role: { not: 'CLIENT' } }, select, orderBy: { name: 'asc' } }));
  } catch (e) { next(e); }
});

usersRouter.post('/', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const data = parse(userSchema.required({ password: true }), req.body);
    validatePasswordStrength(data.password);
    const companyId = companyOf(req);
    const [count, sub] = await Promise.all([
      prisma.user.count({ where: { companyId, role: { not: 'CLIENT' }, active: true } }),
      prisma.subscription.findFirst({ where: { companyId, status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] } } }),
    ]);
    if (sub && count >= sub.maxUsers) throw badRequest(`Limite de ${sub.maxUsers} usuários do plano atingido`);
    const u = await prisma.user.create({ data: { companyId, name: data.name, email: data.email.toLowerCase(), role: data.role, passwordHash: await hashPassword(data.password), permissionGrants: data.permissionGrants ?? [], permissionDenies: data.permissionDenies ?? [], mustChangePassword: true }, select });
    await audit(req.auth!, { action: 'USER_CREATE', entity: 'User', entityId: u.id, after: u });
    res.status(201).json(u);
  } catch (e) { next(e); }
});

usersRouter.put('/:id', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const data = parse(userSchema.partial(), req.body);
    const before = await prisma.user.findFirst({ where: { id: String(req.params.id), companyId: companyOf(req), role: { not: 'CLIENT' } }, select });
    if (!before) throw notFound('Usuário não encontrado');
    if (before.id === req.auth!.userId && (data.active === false || (data.role && data.role !== 'COMPANY_ADMIN' && req.auth!.role === 'COMPANY_ADMIN'))) throw forbidden('Você não pode desativar ou rebaixar o próprio usuário');
    if (data.password) validatePasswordStrength(data.password);
    const u = await prisma.user.update({
      where: { id: before.id },
      data: { name: data.name, email: data.email?.toLowerCase(), role: data.role, active: data.active, permissionGrants: data.permissionGrants, permissionDenies: data.permissionDenies, ...(data.password ? { passwordHash: await hashPassword(data.password), mustChangePassword: true } : {}) },
      select,
    });
    if (data.active === false) await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(req.auth!, { action: 'USER_UPDATE', entity: 'User', entityId: u.id, before, after: u });
    res.json(u);
  } catch (e) { next(e); }
});

/** Matriz de permissões por perfil (configurável pela empresa). */
usersRouter.get('/permissions/matrix', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const rows = await prisma.rolePermission.findMany({ where: { companyId: companyOf(req) } });
    const roles = STAFF.map((role) => ({ role, label: ROLE_LABELS[role], permissions: rows.find((r) => r.role === role)?.permissions ?? DEFAULT_ROLE_PERMISSIONS[role], isDefault: !rows.some((r) => r.role === role) }));
    res.json({ permissions: PERMISSIONS.map((p) => ({ key: p, label: PERMISSION_LABELS[p] })), roles });
  } catch (e) { next(e); }
});

usersRouter.put('/permissions/matrix/:role', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const role = z.enum(['FINANCE', 'COLLECTION']).parse(String(req.params.role));
    const body = parse(z.object({ permissions: z.array(z.enum(PERMISSIONS)) }), req.body);
    const row = await prisma.rolePermission.upsert({ where: { companyId_role: { companyId: companyOf(req), role } }, create: { companyId: companyOf(req), role, permissions: body.permissions }, update: { permissions: body.permissions } });
    await audit(req.auth!, { action: 'ROLE_PERMISSIONS_UPDATE', entity: 'RolePermission', entityId: row.id, after: row });
    res.json(row);
  } catch (e) { next(e); }
});
