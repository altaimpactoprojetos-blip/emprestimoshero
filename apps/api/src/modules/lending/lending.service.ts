/**
 * Empréstimos sobre saldo devedor (engine BALANCE): cadastro, pagamentos parciais com prévia,
 * edição/exclusão com recálculo completo, painel e simulador.
 */
import { z } from 'zod';
import type { Client, Loan, Payment, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { zDate, zDecimal, zId } from '../../lib/validate.js';
import { D, cents, sum, ZERO, type Dec } from '../../lib/money.js';
import { addDays, dateOnly, monthKey, todayIn, daysBetween } from '../../lib/dates.js';
import { nextNumber } from '../../lib/counters.js';
import { audit } from '../../lib/audit.js';
import type { AuthContext } from '../../middleware/auth.js';
import { addEvent, companyTimezone } from '../loans/loans.service.js';
import { computeBalance } from '../../domain/installment.js';
import {
  computeLedger, simulateBalance, monthlyEquivalent, serializeLedger, LedgerError,
  type BalanceTerms, type LedgerPaymentInput, type LedgerResult,
} from '../../domain/balance.js';

// ---------------------------------------------------------------- configurações

export interface CreditorSettings {
  name?: string; nationality?: string; maritalStatus?: string; profession?: string; cpf?: string; rg?: string;
  address?: string; city?: string; state?: string; phone?: string; pixKey?: string;
}
export interface LendingSettings {
  pendingInterestMode: 'SEPARATE' | 'CAPITALIZE';
  lateFineRate: string;
  lateInterestMonthly: string;
  accelerationDays: number;
  quitationDays: number;
  forumCity: string;
}
export const DEFAULT_LENDING: LendingSettings = { pendingInterestMode: 'SEPARATE', lateFineRate: '0', lateInterestMonthly: '0', accelerationDays: 30, quitationDays: 5, forumCity: '' };

export const creditorSchema = z.object({
  name: z.string(), nationality: z.string(), maritalStatus: z.string(), profession: z.string(), cpf: z.string(), rg: z.string(),
  address: z.string(), city: z.string(), state: z.string(), phone: z.string(), pixKey: z.string(),
}).partial();
export const lendingSettingsSchema = z.object({
  pendingInterestMode: z.enum(['SEPARATE', 'CAPITALIZE']),
  lateFineRate: zDecimal, lateInterestMonthly: zDecimal,
  accelerationDays: z.number().int().min(0).max(3650), quitationDays: z.number().int().min(0).max(365),
  forumCity: z.string(),
}).partial();

export function readSettings(settings: unknown): { creditor: CreditorSettings; lending: LendingSettings } {
  const s = (settings ?? {}) as { creditor?: CreditorSettings; lending?: Partial<LendingSettings> };
  return { creditor: s.creditor ?? {}, lending: { ...DEFAULT_LENDING, ...(s.lending ?? {}) } };
}

// ---------------------------------------------------------------- cadastro

const RATE_PERIOD = z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']);
const BILLING = z.enum(['INTEREST_ONLY', 'FIXED_INSTALLMENTS', 'SINGLE_PAYMENT']);
const METHOD = z.enum(['PIX', 'BOLETO', 'CASH', 'TRANSFER', 'CARD', 'OTHER']);

export const termsSchema = z.object({
  amount: zDecimal,
  ratePct: zDecimal,
  ratePeriod: RATE_PERIOD.default('MONTHLY'),
  startDate: zDate,
  maturityDate: zDate,
  billingType: BILLING.default('INTEREST_ONLY'),
  pendingInterestMode: z.enum(['SEPARATE', 'CAPITALIZE']).optional(),
  lateFineRate: zDecimal.optional(),
  lateInterestMonthly: zDecimal.optional(),
});
export const balanceLoanSchema = termsSchema.extend({
  clientId: zId,
  disbursementMethod: z.string().max(60).optional().nullable(),
  notes: z.string().optional().nullable(),
});
export type BalanceLoanInput = z.infer<typeof balanceLoanSchema>;

function toTerms(i: z.infer<typeof termsSchema>, defaults: LendingSettings): BalanceTerms {
  if (D(i.amount).lte(0)) throw badRequest('Informe o valor emprestado');
  if (D(i.ratePct).lt(0)) throw badRequest('Taxa de juros inválida');
  return {
    principal: i.amount, ratePct: i.ratePct, ratePeriod: i.ratePeriod,
    startDate: dateOnly(i.startDate), maturityDate: dateOnly(i.maturityDate), billingType: i.billingType,
    pendingInterestMode: i.pendingInterestMode ?? defaults.pendingInterestMode,
    lateFineRate: i.lateFineRate ?? defaults.lateFineRate, lateInterestMonthly: i.lateInterestMonthly ?? defaults.lateInterestMonthly,
  };
}

export function termsOf(loan: Loan): BalanceTerms {
  if (loan.engine !== 'BALANCE' || !loan.billingType || !loan.periodRate || !loan.maturityDate) throw badRequest('Empréstimo não é do tipo saldo devedor');
  return {
    principal: loan.principalAmount, ratePct: loan.periodRate, ratePeriod: loan.periodicity, startDate: loan.disbursementDate,
    maturityDate: loan.maturityDate, billingType: loan.billingType, pendingInterestMode: loan.pendingInterestMode,
    lateFineRate: loan.lateFineRate, lateInterestMonthly: loan.lateInterestMonthly,
  };
}

const wrap = <T>(fn: () => T): T => {
  try { return fn(); } catch (e) { if (e instanceof LedgerError) throw badRequest(e.message); throw e; }
};

export const BILLING_LABEL: Record<string, string> = { INTEREST_ONLY: 'Só juros a cada período e principal no final', FIXED_INSTALLMENTS: 'Parcelas fixas', SINGLE_PAYMENT: 'Pagamento único com juros no final' };
export const PERIOD_NOUN: Record<string, string> = { DAILY: 'dia', WEEKLY: 'semana', BIWEEKLY: 'quinzena', MONTHLY: 'mês' };

function loanData(input: BalanceLoanInput, terms: BalanceTerms) {
  const sim = wrap(() => simulateBalance(terms));
  const monthly = monthlyEquivalent(terms.ratePct, terms.ratePeriod);
  const annual = D(1).plus(monthly.div(100)).pow(12).minus(1).times(100);
  const amount = cents(input.amount).toFixed(2);
  return {
    engine: 'BALANCE' as const,
    billingType: input.billingType,
    periodRate: D(input.ratePct).toFixed(6),
    maturityDate: terms.maturityDate,
    pendingInterestMode: terms.pendingInterestMode,
    disbursementMethod: input.disbursementMethod ?? null,
    requestedAmount: amount, principalAmount: amount, disbursedAmount: amount,
    disbursementDate: terms.startDate,
    installmentsCount: sim.termPeriods,
    periodicity: input.ratePeriod,
    firstDueDate: sim.periods[0].dueDate,
    monthlyRate: monthly.toFixed(6),
    lateFineRate: D(terms.lateFineRate ?? 0).toFixed(6),
    lateInterestMonthly: D(terms.lateInterestMonthly ?? 0).toFixed(6),
    installmentAmount: sim.firstInstallment.toFixed(2),
    totalAmount: sim.totalToReceive.toFixed(2),
    totalInterest: sim.totalInterest.toFixed(2),
    totalCharges: '0',
    effectiveMonthlyRate: monthly.toFixed(6),
    effectiveAnnualRate: annual.toFixed(6),
    cetMonthly: monthly.toFixed(6),
    cetAnnual: annual.toFixed(6),
    roundingRule: 'HALF_UP_2',
    calcExplanation: `Juros de ${D(input.ratePct).toString().replace('.', ',')}% ao ${PERIOD_NOUN[input.ratePeriod]} calculados sobre o saldo devedor de cada período. ${BILLING_LABEL[input.billingType]}. Pagamentos abatem primeiro encargos de atraso, depois juros e por último o principal. Juros não pagos ${terms.pendingInterestMode === 'CAPITALIZE' ? 'são somados ao principal no período seguinte' : 'ficam pendentes, separados do principal'}.`,
    notes: input.notes ?? null,
  };
}

async function loadClient(companyId: string, id: string) {
  const client = await prisma.client.findFirst({ where: { id, companyId } });
  if (!client) throw notFound('Cliente não encontrado');
  return client;
}

async function companySettings(companyId: string) {
  const c = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { settings: true, timezone: true } });
  return { ...readSettings(c.settings), timezone: c.timezone };
}

export async function createBalanceLoan(ctx: AuthContext, input: BalanceLoanInput) {
  const companyId = ctx.companyId!;
  const client = await loadClient(companyId, input.clientId);
  if (client.status === 'BLOCKED') throw badRequest('Cliente bloqueado para novas operações');
  const { lending } = await companySettings(companyId);
  const terms = toTerms(input, lending);
  const data = loanData(input, terms);
  return prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, companyId, 'LOAN');
    const loan = await tx.loan.create({ data: { ...data, companyId, clientId: client.id, number, createdById: ctx.userId, status: 'ACTIVE', approvedAt: new Date(), approvedById: ctx.userId, disbursedAt: terms.startDate } });
    await addEvent(tx, loan.id, 'CREATED', ctx, { amount: data.principalAmount, ratePct: data.periodRate, ratePeriod: input.ratePeriod, billingType: input.billingType });
    await addEvent(tx, loan.id, 'DISBURSED', ctx, { notes: input.disbursementMethod ? `Entregue por ${input.disbursementMethod}` : undefined });
    await audit(ctx, { action: 'LOAN_CREATE', entity: 'Loan', entityId: loan.id, after: loan }, tx);
    return loan;
  });
}

export async function updateBalanceLoan(ctx: AuthContext, id: string, input: BalanceLoanInput) {
  const companyId = ctx.companyId!;
  const before = await loadBalanceLoan(companyId, id);
  await loadClient(companyId, input.clientId);
  const { lending } = await companySettings(companyId);
  const terms = toTerms(input, lending);
  const data = loanData(input, terms);
  return prisma.$transaction(async (tx) => {
    const loan = await tx.loan.update({ where: { id }, data: { ...data, clientId: input.clientId, disbursedAt: terms.startDate } });
    await recompute(tx, loan.id, companyId);
    await addEvent(tx, id, 'UPDATED', ctx, {});
    await audit(ctx, { action: 'LOAN_UPDATE', entity: 'Loan', entityId: id, before, after: loan }, tx);
    return tx.loan.findUniqueOrThrow({ where: { id } });
  });
}

export async function deleteBalanceLoan(ctx: AuthContext, id: string) {
  const loan = await loadBalanceLoan(ctx.companyId!, id);
  await prisma.$transaction(async (tx) => {
    const contracts = await tx.contract.findMany({ where: { loanId: id }, select: { id: true } });
    await tx.contractSigner.deleteMany({ where: { contractId: { in: contracts.map((c) => c.id) } } });
    await tx.contract.deleteMany({ where: { loanId: id } });
    await tx.payment.deleteMany({ where: { loanId: id } });
    await tx.loanEvent.deleteMany({ where: { loanId: id } });
    await tx.serviceRequest.updateMany({ where: { loanId: id }, data: { loanId: null } });
    await tx.loan.delete({ where: { id } });
    await audit(ctx, { action: 'LOAN_DELETE', entity: 'Loan', entityId: id, before: loan }, tx);
  });
}

async function loadBalanceLoan(companyId: string, id: string, tx: Tx | typeof prisma = prisma) {
  const loan = await tx.loan.findFirst({ where: { id, companyId } });
  if (!loan) throw notFound('Empréstimo não encontrado');
  if (loan.engine !== 'BALANCE') throw badRequest('Este empréstimo usa parcelas pré-calculadas; use a tela de parcelas');
  return loan;
}

// ---------------------------------------------------------------- razão (recalcula tudo)

const ledgerPayments = (payments: Pick<Payment, 'id' | 'paidAt' | 'amount'>[]): LedgerPaymentInput[] => payments.map((p) => ({ id: p.id, date: p.paidAt, amount: p.amount }));

async function confirmedPayments(tx: Tx | typeof prisma, loanId: string) {
  return tx.payment.findMany({ where: { loanId, status: 'CONFIRMED' }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] });
}

export function ledgerOf(loan: Loan, payments: Pick<Payment, 'id' | 'paidAt' | 'amount'>[], today: Date): LedgerResult {
  const last = payments.reduce<Date | null>((m, p) => (!m || p.paidAt > m ? p.paidAt : m), null);
  const asOf = last && last > today ? last : today;
  return wrap(() => computeLedger(termsOf(loan), ledgerPayments(payments), asOf));
}

/** Refaz o cálculo do empréstimo e grava a destinação de cada pagamento e a situação do empréstimo. */
export async function recompute(tx: Tx, loanId: string, companyId: string) {
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
  const payments = await confirmedPayments(tx, loanId);
  const today = todayIn(await companyTimezone(companyId));
  const r = ledgerOf(loan, payments, today);
  for (const a of r.payments) {
    await tx.payment.update({ where: { id: a.id }, data: { principalPortion: a.principal.toFixed(2), interestPortion: a.interest.toFixed(2), chargesPortion: a.charges.toFixed(2), balanceAfter: a.principalAfter.toFixed(2) } });
  }
  if (r.status === 'PAID' && loan.status !== 'PAID') {
    await tx.loan.update({ where: { id: loanId }, data: { status: 'PAID', paidOffAt: new Date() } });
    await addEvent(tx, loanId, 'PAID_OFF', null);
  } else if (r.status !== 'PAID' && loan.status === 'PAID') {
    await tx.loan.update({ where: { id: loanId }, data: { status: 'ACTIVE', paidOffAt: null } });
  }
  return r;
}

// ---------------------------------------------------------------- pagamentos

export const balancePaymentSchema = z.object({
  amount: zDecimal,
  paidAt: zDate,
  method: METHOD.default('PIX'),
  notes: z.string().optional().nullable(),
});
export type BalancePaymentInput = z.infer<typeof balancePaymentSchema>;

function allocationView(r: LedgerResult, id: string) {
  const a = r.payments.find((p) => p.id === id)!;
  return {
    amount: a.amount.toFixed(2), charges: a.charges.toFixed(2), interest: a.interest.toFixed(2), principal: a.principal.toFixed(2),
    principalAfter: a.principalAfter.toFixed(2), interestAfter: a.interestAfter.toFixed(2), chargesAfter: a.chargesAfter.toFixed(2), totalAfter: a.totalAfter.toFixed(2),
    nextPeriodInterest: a.nextPeriodInterest.toFixed(2), paysOff: a.totalAfter.isZero(),
  };
}

/** Mostra, antes de confirmar, quanto vai para juros, quanto vai para principal e o novo saldo. */
export async function previewPayment(companyId: string, loanId: string, input: BalancePaymentInput, editingId?: string) {
  const loan = await loadBalanceLoan(companyId, loanId);
  const today = todayIn(await companyTimezone(companyId));
  if (dateOnly(input.paidAt) > today) throw badRequest('A data do pagamento não pode ser futura');
  const existing = await confirmedPayments(prisma, loanId);
  const id = editingId ?? '__novo__';
  if (editingId && !existing.some((p) => p.id === editingId)) throw notFound('Pagamento não encontrado');
  const list = [...existing.filter((p) => p.id !== id).map((p) => ({ id: p.id, paidAt: p.paidAt, amount: p.amount as Dec | string })), { id, paidAt: dateOnly(input.paidAt), amount: cents(input.amount) }];
  // pagamentos no mesmo dia: o novo entra por último; o editado mantém sua posição
  if (editingId) list.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime() || existing.findIndex((p) => p.id === a.id) - existing.findIndex((p) => p.id === b.id));
  const before = ledgerOf(loan, existing.filter((p) => p.id !== id && p.paidAt <= dateOnly(input.paidAt)), dateOnly(input.paidAt));
  const after = ledgerOf(loan, list as never, today);
  return {
    before: { balance: before.balance.toFixed(2), principalOpen: before.principalOpen.toFixed(2), interestPending: before.interestPending.toFixed(2), chargesPending: before.chargesPending.toFixed(2) },
    allocation: allocationView(after, id),
    summaryAfter: serializeLedger(after),
  };
}

export async function registerBalancePayment(ctx: AuthContext, loanId: string, input: BalancePaymentInput) {
  const companyId = ctx.companyId!;
  await previewPayment(companyId, loanId, input); // valida antes de gravar
  return prisma.$transaction(async (tx) => {
    const loan = await loadBalanceLoan(companyId, loanId, tx);
    const receiptNumber = await nextNumber(tx, companyId, 'RECEIPT');
    const payment = await tx.payment.create({ data: { companyId, loanId, clientId: loan.clientId, receiptNumber, amount: cents(input.amount).toFixed(2), method: input.method, status: 'CONFIRMED', source: 'MANUAL', paidAt: dateOnly(input.paidAt), receivedById: ctx.userId, receivedByName: ctx.userName, notes: input.notes ?? null } });
    const r = await recompute(tx, loanId, companyId);
    await addEvent(tx, loanId, 'PAYMENT', ctx, { paymentId: payment.id, amount: payment.amount.toFixed(2) });
    await audit(ctx, { action: 'PAYMENT_REGISTER', entity: 'Payment', entityId: payment.id, after: { loanId, amount: payment.amount.toFixed(2), paidAt: input.paidAt, method: input.method } }, tx);
    return { payment: await tx.payment.findUniqueOrThrow({ where: { id: payment.id } }), allocation: allocationView(r, payment.id) };
  });
}

export async function updateBalancePayment(ctx: AuthContext, paymentId: string, input: BalancePaymentInput) {
  const companyId = ctx.companyId!;
  const before = await prisma.payment.findFirst({ where: { id: paymentId, companyId, status: 'CONFIRMED' } });
  if (!before) throw notFound('Pagamento não encontrado');
  await previewPayment(companyId, before.loanId, input, paymentId);
  return prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { amount: cents(input.amount).toFixed(2), paidAt: dateOnly(input.paidAt), method: input.method, notes: input.notes ?? null } });
    const r = await recompute(tx, before.loanId, companyId);
    await addEvent(tx, before.loanId, 'PAYMENT_UPDATED', ctx, { paymentId, from: before.amount.toFixed(2), to: cents(input.amount).toFixed(2) });
    await audit(ctx, { action: 'PAYMENT_UPDATE', entity: 'Payment', entityId: paymentId, before, after: input }, tx);
    return { payment: await tx.payment.findUniqueOrThrow({ where: { id: paymentId } }), allocation: allocationView(r, paymentId) };
  });
}

export async function deleteBalancePayment(ctx: AuthContext, paymentId: string) {
  const companyId = ctx.companyId!;
  const p = await prisma.payment.findFirst({ where: { id: paymentId, companyId } });
  if (!p) throw notFound('Pagamento não encontrado');
  await loadBalanceLoan(companyId, p.loanId);
  return prisma.$transaction(async (tx) => {
    await tx.payment.delete({ where: { id: paymentId } });
    await recompute(tx, p.loanId, companyId);
    await addEvent(tx, p.loanId, 'PAYMENT_DELETED', ctx, { paymentId, amount: p.amount.toFixed(2), paidAt: p.paidAt.toISOString().slice(0, 10) });
    await audit(ctx, { action: 'PAYMENT_DELETE', entity: 'Payment', entityId: paymentId, before: p }, tx);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- consultas

type LoanWithClient = Loan & { client: Pick<Client, 'id' | 'name' | 'document' | 'phone'> };

function loanCard(l: LoanWithClient, r: LedgerResult) {
  const s = serializeLedger(r);
  return {
    id: l.id, number: l.number, status: l.status, engine: l.engine, billingType: l.billingType, periodRate: l.periodRate?.toString() ?? null, periodicity: l.periodicity,
    startDate: l.disbursementDate.toISOString().slice(0, 10), maturityDate: l.maturityDate?.toISOString().slice(0, 10) ?? null,
    client: l.client,
    summary: { ...s, payments: undefined, periods: undefined },
  };
}

export async function listBalanceLoans(companyId: string, filter: { clientId?: string; status?: string; q?: string }) {
  const today = todayIn(await companyTimezone(companyId));
  const loans = await prisma.loan.findMany({
    where: { companyId, engine: 'BALANCE', status: { in: ['ACTIVE', 'PAID'] }, ...(filter.clientId ? { clientId: filter.clientId } : {}), ...(filter.q ? { client: { name: { contains: filter.q, mode: 'insensitive' } } } : {}) },
    include: { client: { select: { id: true, name: true, document: true, phone: true } }, payments: { where: { status: 'CONFIRMED' }, select: { id: true, paidAt: true, amount: true, createdAt: true }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] } },
    orderBy: { number: 'desc' },
    take: 3000,
  });
  const cards = loans.map((l) => loanCard(l, ledgerOf(l, l.payments, today)));
  const wanted = filter.status ? filter.status.split(',') : null;
  return wanted ? cards.filter((c) => wanted.includes(c.summary.status) || (wanted.includes('DUE_SOON') && ['DUE_TODAY', 'DUE_THIS_WEEK'].includes(c.summary.status))) : cards;
}

export async function balanceLoanDetail(companyId: string, id: string) {
  const loan = await prisma.loan.findFirst({
    where: { id, companyId, engine: 'BALANCE' },
    include: {
      client: true,
      contracts: { orderBy: { createdAt: 'desc' }, include: { file: { select: { id: true, filename: true } } } },
      events: { orderBy: { createdAt: 'asc' } },
      payments: { where: { status: 'CONFIRMED' }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] },
    },
  });
  if (!loan) throw notFound('Empréstimo não encontrado');
  const today = todayIn(await companyTimezone(companyId));
  const r = ledgerOf(loan, loan.payments, today);
  const ledger = serializeLedger(r);
  const byId = new Map(loan.payments.map((p) => [p.id, p]));
  const history = ledger.payments.map((a) => {
    const p = byId.get(a.id)!;
    return { ...a, method: p.method, notes: p.notes, receiptNumber: p.receiptNumber, receivedByName: p.receivedByName, createdAt: p.createdAt };
  });
  return { ...loan, payments: undefined, history, ledger, today: today.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------- painel

interface DueItem { loanId: string; number: number; clientId: string; clientName: string; clientPhone: string | null; dueDate: string; amount: string; daysLate: number; kind: 'BALANCE' | 'INSTALLMENT' }

export async function lendingDashboard(companyId: string, opts: { clientId?: string } = {}) {
  const today = todayIn(await companyTimezone(companyId));
  const weekEnd = addDays(today, 7);
  const month = monthKey(today);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const clientWhere = opts.clientId ? { clientId: opts.clientId } : {};
  const [balanceLoans, legacyInstallments, legacyLoans, payments] = await Promise.all([
    prisma.loan.findMany({ where: { companyId, engine: 'BALANCE', status: { in: ['ACTIVE', 'PAID'] }, ...clientWhere }, include: { client: { select: { id: true, name: true, document: true, phone: true } }, payments: { where: { status: 'CONFIRMED' }, select: { id: true, paidAt: true, amount: true, createdAt: true }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] } } }),
    prisma.installment.findMany({ where: { companyId, status: { in: ['PENDING', 'PARTIAL'] }, loan: { status: 'ACTIVE', engine: 'SCHEDULE', ...clientWhere } }, include: { loan: { select: { id: true, number: true, lateFineRate: true, lateInterestMonthly: true, client: { select: { id: true, name: true, phone: true } } } } } }),
    prisma.loan.findMany({ where: { companyId, engine: 'SCHEDULE', status: { in: ['ACTIVE', 'PAID', 'RENEGOTIATED'] }, parentLoanId: null, ...clientWhere }, select: { disbursedAmount: true } }),
    prisma.payment.findMany({ where: { companyId, status: 'CONFIRMED', source: { not: 'RENEGOTIATION' }, ...clientWhere }, select: { amount: true, interestPortion: true, chargesPortion: true, paidAt: true } }),
  ]);
  let outstanding = ZERO, interestToReceive = ZERO, overdueAmount = ZERO;
  const dueToday: DueItem[] = [], dueWeek: DueItem[] = [], overdue: DueItem[] = [];
  const statusCount: Record<string, number> = { ON_TIME: 0, DUE_TODAY: 0, DUE_THIS_WEEK: 0, OVERDUE: 0, PAID: 0 };
  const overdueClients = new Set<string>();
  for (const l of balanceLoans) {
    const r = ledgerOf(l, l.payments, today);
    statusCount[r.status]++;
    if (r.status === 'PAID') continue;
    outstanding = outstanding.plus(r.balance);
    interestToReceive = interestToReceive.plus(r.interestPending).plus(r.chargesPending).plus(r.futureInterest);
    const base = { loanId: l.id, number: l.number, clientId: l.client.id, clientName: l.client.name, clientPhone: l.client.phone, kind: 'BALANCE' as const };
    if (r.overdueAmount.gt(0)) {
      overdueAmount = overdueAmount.plus(r.overdueAmount).plus(r.chargesPending);
      overdueClients.add(l.client.id);
      overdue.push({ ...base, dueDate: iso(addDays(today, -r.daysLate)), amount: r.overdueAmount.plus(r.chargesPending).toFixed(2), daysLate: r.daysLate });
    }
    if (r.nextDue && r.nextDue.date.getTime() === today.getTime()) dueToday.push({ ...base, dueDate: iso(r.nextDue.date), amount: r.nextDue.amount.toFixed(2), daysLate: 0 });
    else if (r.nextDue && r.nextDue.date > today && r.nextDue.date <= weekEnd) dueWeek.push({ ...base, dueDate: iso(r.nextDue.date), amount: r.nextDue.amount.toFixed(2), daysLate: 0 });
  }
  for (const i of legacyInstallments) {
    const b = computeBalance(i, i.loan, today);
    outstanding = outstanding.plus(b.totalDue);
    interestToReceive = interestToReceive.plus(b.interestOpen).plus(b.chargesDue);
    const base = { loanId: i.loan.id, number: i.loan.number, clientId: i.loan.client.id, clientName: `${i.loan.client.name} (parcela ${i.number})`, clientPhone: i.loan.client.phone, dueDate: iso(i.dueDate), amount: b.totalDue.toFixed(2), kind: 'INSTALLMENT' as const };
    if (b.daysLate > 0) { overdueAmount = overdueAmount.plus(b.totalDue); overdueClients.add(i.loan.client.id); overdue.push({ ...base, daysLate: b.daysLate }); }
    else if (dateOnly(i.dueDate).getTime() === today.getTime()) dueToday.push({ ...base, daysLate: 0 });
    else if (i.dueDate > today && i.dueDate <= weekEnd) dueWeek.push({ ...base, daysLate: 0 });
  }
  const lent = sum([...balanceLoans.map((l) => l.principalAmount), ...legacyLoans.map((l) => l.disbursedAmount)]);
  const received = sum(payments.map((p) => p.amount));
  const interestReceived = sum(payments.map((p) => D(p.interestPortion).plus(p.chargesPortion)));
  const receivedMonth = sum(payments.filter((p) => monthKey(p.paidAt) === month).map((p) => p.amount));
  overdue.sort((a, b) => b.daysLate - a.daysLate);
  dueWeek.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    today: iso(today),
    totals: {
      lent: lent.toFixed(2), received: received.toFixed(2), interestReceived: interestReceived.toFixed(2), interestToReceive: interestToReceive.toFixed(2),
      outstanding: outstanding.toFixed(2), receivedMonth: receivedMonth.toFixed(2), overdueAmount: overdueAmount.toFixed(2), overdueClients: overdueClients.size,
    },
    statusCount,
    dueToday, dueWeek, overdue,
  };
}

// ---------------------------------------------------------------- simulador

export async function simulate(companyId: string, input: z.infer<typeof termsSchema>) {
  const { lending } = await companySettings(companyId);
  const terms = toTerms(input, lending);
  const s = wrap(() => simulateBalance(terms));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    termPeriods: s.termPeriods,
    principal: s.principal.toFixed(2),
    totalInterest: s.totalInterest.toFixed(2),
    totalToReceive: s.totalToReceive.toFixed(2),
    firstInstallment: s.firstInstallment.toFixed(2),
    monthlyEquivalent: monthlyEquivalent(terms.ratePct, terms.ratePeriod).toFixed(4),
    periods: s.periods.map((p) => ({ number: p.number, dueDate: iso(p.dueDate), openingPrincipal: p.openingPrincipal.toFixed(2), interest: p.interest.toFixed(2), principalDue: p.principalDue.toFixed(2), amountDue: p.amountDue.toFixed(2) })),
  };
}

export const notFoundPayment = () => notFound('Pagamento não encontrado');

export { daysBetween, type Prisma };
