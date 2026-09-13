import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';

export const auditRouter = Router();
auditRouter.use(authenticate, requireCompany, requirePermission('audit.view'));

auditRouter.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Number(req.query.pageSize ?? 50));
    const where = {
      companyId: companyOf(req),
      ...(req.query.entity ? { entity: String(req.query.entity) } : {}),
      ...(req.query.entityId ? { entityId: String(req.query.entityId) } : {}),
      ...(req.query.userId ? { userId: String(req.query.userId) } : {}),
      ...(req.query.q ? { action: { contains: String(req.query.q).toUpperCase() } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ items, total, page, pageSize });
  } catch (e) { next(e); }
});
