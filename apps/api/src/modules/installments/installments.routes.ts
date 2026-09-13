import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireCompany, requirePermission, companyOf } from '../../middleware/auth.js';
import { computeBalance } from '../../domain/installment.js';
import { todayIn } from '../../lib/dates.js';
import { serializeBalance } from '../clients/clients.routes.js';
import { companyTimezone } from '../loans/loans.service.js';
import { addDays } from 'date-fns';
import type { Prisma } from '@prisma/client';

export const installmentsRouter = Router();
installmentsRouter.use(authenticate, requireCompany);

/**
 * Lista de parcelas da empresa com filtro por situação calculada:
 * upcoming | due_today | overdue | partial | paid | renegotiated | open (todas em aberto)
 */
installmentsRouter.get('/', requirePermission('installments.view'), async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const filter = String(req.query.filter ?? 'open');
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
    const from = typeof req.query.from === 'string' && req.query.from ? new Date(req.query.from) : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? new Date(req.query.to) : undefined;
    const today = todayIn(await companyTimezone(companyId));
    const statusWhere: Prisma.InstallmentWhereInput = filter === 'paid' ? { status: 'PAID' } : filter === 'renegotiated' ? { status: 'RENEGOTIATED' } : filter === 'partial' ? { status: 'PARTIAL' } : { status: { in: ['PENDING', 'PARTIAL'] } };
    const dateWhere: Prisma.InstallmentWhereInput = filter === 'upcoming' ? { dueDate: { gt: today, ...(to ? { lte: to } : {}) } } : filter === 'due_today' ? { dueDate: today } : filter === 'overdue' ? { dueDate: { lt: today } } : filter === 'next7' ? { dueDate: { gte: today, lte: addDays(today, 7) } } : from || to ? { dueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
    const rows = await prisma.installment.findMany({
      where: { companyId, ...statusWhere, ...dateWhere, loan: { ...(filter === 'paid' || filter === 'renegotiated' ? {} : { status: 'ACTIVE' as const }), ...(clientId ? { clientId } : {}) } },
      include: { loan: { select: { id: true, number: true, lateFineRate: true, lateInterestMonthly: true, collectionState: true, client: { select: { id: true, name: true, document: true, phone: true, email: true } } } } },
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
      take: 3000,
    });
    res.json(rows.map((i) => ({ ...i, balance: serializeBalance(computeBalance(i, i.loan, today)) })));
  } catch (e) { next(e); }
});
