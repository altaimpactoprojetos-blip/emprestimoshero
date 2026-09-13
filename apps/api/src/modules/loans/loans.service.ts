import { z } from 'zod';
import type { Loan, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { simulate, serializeSimulation, type SimulationInput } from '../../domain/finance.js';
import { computeBalance } from '../../domain/installment.js';
import { dateOnly, todayIn } from '../../lib/dates.js';
import { nextNumber } from '../../lib/counters.js';
import { zDate, zDecimal, zId } from '../../lib/validate.js';
import type { AuthContext } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { D, sum } from '../../lib/money.js';
import { serializeBalance } from '../clients/clients.routes.js';

export const loanInputSchema = z.object({
  clientId: zId,
  productId: zId.optional().nullable(),
  requestedAmount: zDecimal,
  installmentsCount: z.number().int().min(1).max(360),
  periodicity: z.enum(['MONTHLY', 'BIWEEKLY', 'WEEKLY', 'DAILY']).default('MONTHLY'),
  disbursementDate: zDate,
  firstDueDate: zDate,
  calcMethod: z.enum(['PRICE', 'SAC', 'SIMPLE']).default('PRICE'),
  monthlyRate: zDecimal,
  chargeMode: z.enum(['DEDUCTED', 'FINANCED']).default('DEDUCTED'),
  originationFee: zDecimal.default('0'),
  originationFeeRate: zDecimal.default('0'),
  iofFixedRate: zDecimal.default('0'),
  iofDailyRate: zDecimal.default('0'),
  lateFineRate: zDecimal.default('2'),
  lateInterestMonthly: zDecimal.default('1'),
  notes: z.string().optional().nullable(),
});
export type LoanInput = z.infer<typeof loanInputSchema>;

export const simulationSchema = loanInputSchema.omit({ clientId: true, notes: true }).extend({ clientId: zId.optional() });

export function toSimulationInput(i: Omit<LoanInput, 'clientId' | 'notes'>): SimulationInput {
  return {
    requestedAmount: i.requestedAmount,
    installmentsCount: i.installmentsCount,
    periodicity: i.periodicity,
    disbursementDate: dateOnly(i.disbursementDate),
    firstDueDate: dateOnly(i.firstDueDate),
    calcMethod: i.calcMethod,
    monthlyRate: i.monthlyRate,
    chargeMode: i.chargeMode,
    originationFee: i.originationFee,
    originationFeeRate: i.originationFeeRate,
    iofFixedRate: i.iofFixedRate,
    iofDailyRate: i.iofDailyRate,
  };
}

export function runSimulation(i: Omit<LoanInput, 'clientId' | 'notes'>) {
  try {
    return simulate(toSimulationInput(i));
  } catch (e) {
    throw badRequest((e as Error).message);
  }
}

const EDITABLE: Loan['status'][] = ['DRAFT', 'UNDER_REVIEW', 'APPROVED'];

export async function companyTimezone(companyId: string) {
  return (await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true } })).timezone;
}

export async function loadLoan(companyId: string, id: string) {
  const loan = await prisma.loan.findFirst({ where: { id, companyId } });
  if (!loan) throw notFound('Empréstimo não encontrado');
  return loan;
}

function loanDataFromInput(input: LoanInput, sim: ReturnType<typeof simulate>): Omit<Prisma.LoanUncheckedCreateInput, 'companyId' | 'number' | 'clientId'> {
  return {
    productId: input.productId ?? null,
    requestedAmount: sim.requestedAmount.toFixed(2),
    principalAmount: sim.principalAmount.toFixed(2),
    disbursedAmount: sim.disbursedAmount.toFixed(2),
    disbursementDate: dateOnly(input.disbursementDate),
    installmentsCount: input.installmentsCount,
    periodicity: input.periodicity,
    firstDueDate: dateOnly(input.firstDueDate),
    calcMethod: input.calcMethod,
    monthlyRate: sim.monthlyRate.toFixed(6),
    chargeMode: input.chargeMode,
    originationFee: sim.originationFee.toFixed(2),
    iofAmount: sim.iofAmount.toFixed(2),
    iofFixedRate: D(input.iofFixedRate).toFixed(6),
    iofDailyRate: D(input.iofDailyRate).toFixed(6),
    lateFineRate: D(input.lateFineRate).toFixed(6),
    lateInterestMonthly: D(input.lateInterestMonthly).toFixed(6),
    installmentAmount: sim.installmentAmount.toFixed(2),
    totalAmount: sim.totalAmount.toFixed(2),
    totalInterest: sim.totalInterest.toFixed(2),
    totalCharges: sim.totalCharges.toFixed(2),
    effectiveMonthlyRate: sim.effectiveMonthlyRate.toFixed(6),
    effectiveAnnualRate: sim.effectiveAnnualRate.toFixed(6),
    cetMonthly: sim.cetMonthly.toFixed(6),
    cetAnnual: sim.cetAnnual.toFixed(6),
    roundingRule: sim.roundingRule,
    calcExplanation: sim.explanation,
    notes: input.notes ?? null,
  };
}

export async function addEvent(tx: Tx | typeof prisma, loanId: string, type: string, ctx: Partial<AuthContext> | null, data?: unknown) {
  await tx.loanEvent.create({ data: { loanId, type, userId: ctx?.userId ?? null, userName: ctx?.userName ?? null, data: data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as never) } });
}

export async function createLoan(ctx: AuthContext, input: LoanInput, opts: { parentLoanId?: string; source?: 'RENEGOTIATION'; tx?: Tx } = {}) {
  const companyId = ctx.companyId!;
  const client = await prisma.client.findFirst({ where: { id: input.clientId, companyId } });
  if (!client) throw notFound('Cliente não encontrado');
  if (client.status === 'BLOCKED') throw badRequest('Cliente bloqueado para novas operações');
  const sim = runSimulation(input);
  const run = async (tx: Tx) => {
    const number = await nextNumber(tx, companyId, 'LOAN');
    const loan = await tx.loan.create({
      data: { ...loanDataFromInput(input, sim), companyId, clientId: client.id, number, createdById: ctx.userId, parentLoanId: opts.parentLoanId ?? null, status: 'DRAFT' },
    });
    await tx.installment.createMany({
      data: sim.schedule.map((r) => ({ companyId, loanId: loan.id, number: r.number, dueDate: r.dueDate, principalAmount: r.principal.toFixed(2), interestAmount: r.interest.toFixed(2), originalAmount: r.amount.toFixed(2) })),
    });
    await addEvent(tx, loan.id, opts.source === 'RENEGOTIATION' ? 'CREATED_FROM_RENEGOTIATION' : 'CREATED', ctx, { requestedAmount: sim.requestedAmount.toFixed(2), installments: input.installmentsCount });
    await audit(ctx, { action: 'LOAN_CREATE', entity: 'Loan', entityId: loan.id, after: loan }, tx);
    return loan;
  };
  return opts.tx ? run(opts.tx) : prisma.$transaction(run);
}

export async function updateLoan(ctx: AuthContext, id: string, input: LoanInput) {
  const before = await loadLoan(ctx.companyId!, id);
  if (!EDITABLE.includes(before.status)) throw badRequest('Empréstimo não pode mais ser editado neste estado');
  const signed = await prisma.contract.count({ where: { loanId: id, status: { in: ['SIGNED', 'AWAITING_SIGNATURE'] } } });
  if (signed) throw badRequest('Existe contrato assinado ou em assinatura; gere um aditivo em vez de alterar as condições');
  const sim = runSimulation(input);
  return prisma.$transaction(async (tx) => {
    const loan = await tx.loan.update({ where: { id }, data: { ...loanDataFromInput(input, sim), clientId: input.clientId, status: before.status === 'APPROVED' ? 'UNDER_REVIEW' : before.status, approvedAt: before.status === 'APPROVED' ? null : before.approvedAt, approvedById: before.status === 'APPROVED' ? null : before.approvedById } });
    await tx.installment.deleteMany({ where: { loanId: id } });
    await tx.installment.createMany({ data: sim.schedule.map((r) => ({ companyId: ctx.companyId!, loanId: loan.id, number: r.number, dueDate: r.dueDate, principalAmount: r.principal.toFixed(2), interestAmount: r.interest.toFixed(2), originalAmount: r.amount.toFixed(2) })) });
    await addEvent(tx, id, 'UPDATED', ctx, { previousStatus: before.status });
    await audit(ctx, { action: 'LOAN_UPDATE', entity: 'Loan', entityId: id, before, after: loan }, tx);
    return loan;
  });
}

export async function transition(ctx: AuthContext, id: string, action: 'submit' | 'assess' | 'approve' | 'reject' | 'disburse' | 'cancel', body: { notes?: string; score?: number; reason?: string; date?: string; disbursedAmount?: string }) {
  const loan = await loadLoan(ctx.companyId!, id);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    let data: Prisma.LoanUpdateInput = {};
    let event = '';
    switch (action) {
      case 'submit':
        if (loan.status !== 'DRAFT') throw badRequest('Somente propostas podem ser enviadas para avaliação');
        data = { status: 'UNDER_REVIEW' }; event = 'SUBMITTED'; break;
      case 'assess':
        if (!['DRAFT', 'UNDER_REVIEW'].includes(loan.status)) throw badRequest('Avaliação só é possível antes da aprovação');
        data = { status: 'UNDER_REVIEW', assessmentNotes: body.notes ?? loan.assessmentNotes, assessmentScore: body.score ?? loan.assessmentScore }; event = 'ASSESSED'; break;
      case 'approve':
        if (!['DRAFT', 'UNDER_REVIEW'].includes(loan.status)) throw badRequest('Empréstimo não está aguardando aprovação');
        data = { status: 'APPROVED', approvedAt: now, approvedById: ctx.userId, assessmentNotes: body.notes ?? loan.assessmentNotes }; event = 'APPROVED'; break;
      case 'reject':
        if (!['DRAFT', 'UNDER_REVIEW', 'APPROVED'].includes(loan.status)) throw badRequest('Empréstimo não pode ser rejeitado neste estado');
        data = { status: 'REJECTED', rejectedReason: body.reason ?? null }; event = 'REJECTED'; break;
      case 'disburse': {
        if (!['APPROVED', 'AWAITING_SIGNATURE', 'SIGNED'].includes(loan.status)) throw badRequest('A liberação exige empréstimo aprovado');
        const signedContract = await tx.contract.findFirst({ where: { loanId: id, status: 'SIGNED' } });
        const date = body.date ? dateOnly(body.date) : todayIn(await companyTimezone(ctx.companyId!));
        data = { status: 'ACTIVE', disbursedAt: date, notes: loan.notes }; event = 'DISBURSED';
        body = { ...body, notes: signedContract ? undefined : 'Liberado sem contrato assinado registrado no sistema' };
        break;
      }
      case 'cancel':
        if (['ACTIVE', 'PAID', 'RENEGOTIATED'].includes(loan.status)) throw badRequest('Empréstimos liberados não podem ser cancelados; use quitação ou renegociação');
        data = { status: 'CANCELLED', cancelledAt: now }; event = 'CANCELLED'; break;
    }
    const updated = await tx.loan.update({ where: { id }, data });
    if (action === 'cancel') await tx.contract.updateMany({ where: { loanId: id, status: { not: 'SIGNED' } }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'Empréstimo cancelado' } });
    await addEvent(tx, id, event, ctx, { ...body });
    await audit(ctx, { action: `LOAN_${event}`, entity: 'Loan', entityId: id, before: { status: loan.status }, after: { status: updated.status, ...body } }, tx);
    return updated;
  });
}

export async function setCollectionState(ctx: AuthContext, id: string, state: 'ACTIVE' | 'PAUSED', reason?: string) {
  const loan = await loadLoan(ctx.companyId!, id);
  const updated = await prisma.loan.update({ where: { id }, data: { collectionState: state, collectionPauseReason: state === 'PAUSED' ? reason ?? 'Pausa manual' : null } });
  if (state === 'PAUSED') await prisma.reminder.updateMany({ where: { installment: { loanId: id }, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelReason: `Cobrança pausada: ${reason ?? 'manual'}` } });
  await addEvent(prisma, id, state === 'PAUSED' ? 'COLLECTION_PAUSED' : 'COLLECTION_RESUMED', ctx, { reason });
  await audit(ctx, { action: state === 'PAUSED' ? 'LOAN_COLLECTION_PAUSED' : 'LOAN_COLLECTION_RESUMED', entity: 'Loan', entityId: id, before: { collectionState: loan.collectionState }, after: { collectionState: state, reason } });
  return updated;
}

export async function loanDetail(companyId: string, id: string) {
  const loan = await prisma.loan.findFirst({
    where: { id, companyId },
    include: {
      client: true,
      product: true,
      installments: { orderBy: { number: 'asc' }, include: { charges: { orderBy: { createdAt: 'desc' }, take: 3 } } },
      payments: { orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }], include: { installment: { select: { number: true } }, proofFile: { select: { id: true, filename: true } } } },
      contracts: { orderBy: { createdAt: 'desc' }, include: { signers: true, file: { select: { id: true, filename: true } } } },
      events: { orderBy: { createdAt: 'asc' } },
      parentLoan: { select: { id: true, number: true } },
      children: { select: { id: true, number: true, status: true } },
      renegotiationsFrom: true,
    },
  });
  if (!loan) throw notFound('Empréstimo não encontrado');
  const today = todayIn(await companyTimezone(companyId));
  const installments = loan.installments.map((i) => ({ ...i, balance: serializeBalance(computeBalance(i, loan, today)) }));
  const open = installments.filter((i) => ['PENDING', 'PARTIAL'].includes(i.status));
  const summary = {
    openBalance: loan.status === 'ACTIVE' ? sum(open.map((i) => i.balance.totalDue)).toFixed(2) : '0.00',
    principalOpen: sum(open.map((i) => i.balance.principalOpen)).toFixed(2),
    overdueBalance: sum(open.filter((i) => i.balance.daysLate > 0).map((i) => i.balance.totalDue)).toFixed(2),
    overdueCount: open.filter((i) => i.balance.daysLate > 0).length,
    maxDaysLate: Math.max(0, ...open.map((i) => i.balance.daysLate)),
    paidCount: installments.filter((i) => i.status === 'PAID').length,
    totalPaid: sum(loan.payments.filter((p) => p.status === 'CONFIRMED').map((p) => p.amount)).toFixed(2),
    principalPaid: sum(loan.payments.filter((p) => p.status === 'CONFIRMED').map((p) => p.principalPortion)).toFixed(2),
    interestPaid: sum(loan.payments.filter((p) => p.status === 'CONFIRMED').map((p) => p.interestPortion)).toFixed(2),
    chargesPaid: sum(loan.payments.filter((p) => p.status === 'CONFIRMED').map((p) => p.chargesPortion)).toFixed(2),
    signedContract: loan.contracts.some((c) => c.status === 'SIGNED'),
  };
  return { ...loan, installments, summary, today: today.toISOString().slice(0, 10) };
}

export { serializeSimulation };
