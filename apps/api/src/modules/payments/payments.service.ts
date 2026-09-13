import { z } from 'zod';
import type { Installment, Loan, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { computeBalance, allocatePayment, earlyPayoffAmount } from '../../domain/installment.js';
import { dateOnly, periodDays, todayIn, formatBRDate } from '../../lib/dates.js';
import { D, cents, sum, ZERO, formatBRL, type Dec } from '../../lib/money.js';
import { nextNumber } from '../../lib/counters.js';
import { zDate, zDecimal, zId } from '../../lib/validate.js';
import type { AuthContext } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { addEvent, companyTimezone, createLoan, loanInputSchema } from '../loans/loans.service.js';
import { renderPdf } from '../../services/pdf.js';
import { maskDoc } from '../../lib/text.js';

export const paymentSchema = z.object({
  installmentId: zId,
  amount: zDecimal,
  discount: zDecimal.default('0'),
  method: z.enum(['PIX', 'BOLETO', 'CASH', 'TRANSFER', 'CARD', 'OTHER']).default('OTHER'),
  paidAt: zDate,
  notes: z.string().optional().nullable(),
  proofFileId: zId.optional().nullable(),
  chargeId: zId.optional().nullable(),
  source: z.enum(['MANUAL', 'PROVIDER', 'CLIENT_UPLOAD']).default('MANUAL'),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

async function loadInstallment(companyId: string, id: string, tx: Tx | typeof prisma = prisma) {
  const inst = await tx.installment.findFirst({ where: { id, companyId }, include: { loan: true } });
  if (!inst) throw notFound('Parcela não encontrada');
  return inst;
}

/** Efeitos após confirmação de pagamento: recibo, lembretes, cobranças abertas e situação do empréstimo. */
export async function afterPaymentConfirmed(tx: Tx, inst: Installment & { loan: Loan }, ctx: Partial<AuthContext> | null) {
  const fresh = await tx.installment.findUniqueOrThrow({ where: { id: inst.id } });
  if (fresh.status === 'PAID') {
    await tx.reminder.updateMany({ where: { installmentId: inst.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelReason: 'Parcela quitada' } });
    await tx.charge.updateMany({ where: { installmentId: inst.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
  } else if (fresh.status === 'PARTIAL') {
    // cobrança recalculada: cobranças Pix/boleto pendentes com valor antigo são canceladas; lembretes seguem com saldo atualizado no envio
    await tx.charge.updateMany({ where: { installmentId: inst.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
  }
  const openCount = await tx.installment.count({ where: { loanId: inst.loanId, status: { in: ['PENDING', 'PARTIAL'] } } });
  if (openCount === 0 && inst.loan.status === 'ACTIVE') {
    await tx.loan.update({ where: { id: inst.loanId }, data: { status: 'PAID', paidOffAt: new Date() } });
    await tx.reminder.updateMany({ where: { installment: { loanId: inst.loanId }, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelReason: 'Empréstimo quitado' } });
    await addEvent(tx, inst.loanId, 'PAID_OFF', ctx);
  }
}

export async function registerPayment(ctx: AuthContext, input: PaymentInput, opts: { status?: 'CONFIRMED' | 'PENDING_REVIEW'; tx?: Tx; receivedByName?: string } = {}) {
  const companyId = ctx.companyId!;
  const amount = cents(input.amount);
  const discount = cents(input.discount ?? 0);
  if (amount.lte(0) && discount.lte(0)) throw badRequest('Informe o valor recebido');
  if (discount.gt(0) && !ctx.permissions.has('discounts.grant') && ctx.role !== 'COMPANY_ADMIN') throw forbidden('Sem permissão para conceder desconto');
  const run = async (tx: Tx) => {
    const inst = await loadInstallment(companyId, input.installmentId, tx);
    if (inst.loan.status !== 'ACTIVE') throw badRequest('Somente empréstimos liberados recebem pagamentos');
    if (!['PENDING', 'PARTIAL'].includes(inst.status)) throw badRequest('Parcela não está em aberto');
    const paidAt = dateOnly(input.paidAt);
    const balance = computeBalance(inst, inst.loan, paidAt);
    let alloc;
    try { alloc = allocatePayment(balance, amount, discount); } catch (e) { throw badRequest((e as Error).message); }
    const status = opts.status ?? 'CONFIRMED';
    const receiptNumber = status === 'CONFIRMED' ? await nextNumber(tx, companyId, 'RECEIPT') : null;
    const payment = await tx.payment.create({
      data: {
        companyId, loanId: inst.loanId, installmentId: inst.id, clientId: inst.loan.clientId, receiptNumber,
        amount: amount.toFixed(2), principalPortion: alloc.principalPortion.toFixed(2), interestPortion: alloc.interestPortion.toFixed(2), chargesPortion: alloc.chargesPortion.toFixed(2), discountAmount: discount.toFixed(2),
        method: input.method, status, source: input.source, paidAt, receivedById: ctx.userId, receivedByName: opts.receivedByName ?? ctx.userName, proofFileId: input.proofFileId ?? null, chargeId: input.chargeId ?? null, notes: input.notes ?? null,
      },
    });
    if (status === 'CONFIRMED') {
      await applyPaymentToInstallment(tx, inst, balance, alloc, paidAt, discount);
      await addEvent(tx, inst.loanId, 'PAYMENT', ctx, { paymentId: payment.id, installment: inst.number, amount: amount.toFixed(2), discount: discount.toFixed(2) });
      await afterPaymentConfirmed(tx, inst, ctx);
    }
    await audit(ctx, { action: status === 'CONFIRMED' ? 'PAYMENT_REGISTER' : 'PAYMENT_PROOF_SUBMIT', entity: 'Payment', entityId: payment.id, after: { installmentId: inst.id, amount: amount.toFixed(2), discount: discount.toFixed(2), method: input.method, status } }, tx);
    return payment;
  };
  return opts.tx ? run(opts.tx) : prisma.$transaction(run);
}

async function applyPaymentToInstallment(tx: Tx, inst: Installment, balance: ReturnType<typeof computeBalance>, alloc: ReturnType<typeof allocatePayment>, paidAt: Date, discount: Dec) {
  const remaining = alloc.remainingAfter;
  const chargesUnpaid = balance.chargesDue.minus(alloc.chargesPortion).minus(alloc.discountCharges);
  await tx.installment.update({
    where: { id: inst.id },
    data: {
      paidPrincipal: D(inst.paidPrincipal).plus(alloc.principalPortion).plus(alloc.discountPrincipal).toFixed(2),
      paidInterest: D(inst.paidInterest).plus(alloc.interestPortion).plus(alloc.discountInterest).toFixed(2),
      paidCharges: D(inst.paidCharges).plus(alloc.chargesPortion).toFixed(2),
      discountAmount: D(inst.discountAmount).plus(discount).toFixed(2),
      chargesCarried: remaining.isZero() ? '0' : chargesUnpaid.toFixed(2),
      fineApplied: inst.fineApplied || balance.daysLate > 0,
      lastPaymentAt: paidAt,
      status: remaining.isZero() ? 'PAID' : 'PARTIAL',
      paidAt: remaining.isZero() ? new Date() : null,
    },
  });
}

export async function reversePayment(ctx: AuthContext, paymentId: string, reason: string) {
  if (!reason || reason.trim().length < 5) throw badRequest('Informe a justificativa do estorno');
  return prisma.$transaction(async (tx) => {
    const p = await tx.payment.findFirst({ where: { id: paymentId, companyId: ctx.companyId! }, include: { installment: { include: { loan: true } } } });
    if (!p) throw notFound('Pagamento não encontrado');
    if (p.status !== 'CONFIRMED') throw badRequest('Somente pagamentos confirmados podem ser estornados');
    if (p.source === 'PAYOFF' || p.source === 'RENEGOTIATION') throw badRequest('Lançamentos de quitação/renegociação não são estornáveis individualmente');
    const inst = p.installment;
    if (inst.status === 'RENEGOTIATED') throw badRequest('Parcela renegociada; estorne pela renegociação');
    // O pagamento original é preservado (status REVERSED); a parcela volta a refletir o saldo anterior.
    const otherPayments = await tx.payment.findMany({ where: { installmentId: inst.id, status: 'CONFIRMED', id: { not: p.id } }, orderBy: { paidAt: 'desc' } });
    const lastOther = otherPayments[0];
    await tx.payment.update({ where: { id: p.id }, data: { status: 'REVERSED', reversedAt: new Date(), reversedById: ctx.userId, reversalReason: reason } });
    const paidPrincipal = D(inst.paidPrincipal).minus(p.principalPortion);
    const paidInterest = D(inst.paidInterest).minus(p.interestPortion);
    const paidCharges = D(inst.paidCharges).minus(p.chargesPortion);
    const discountAmount = D(inst.discountAmount).minus(p.discountAmount);
    const openBase = D(inst.principalAmount).minus(paidPrincipal).minus(D(inst.interestAmount).minus(paidInterest).lt(0) ? 0 : 0);
    const stillPaid = D(inst.principalAmount).minus(paidPrincipal).plus(D(inst.interestAmount).minus(paidInterest)).lte(0);
    await tx.installment.update({
      where: { id: inst.id },
      data: {
        paidPrincipal: paidPrincipal.toFixed(2), paidInterest: paidInterest.toFixed(2), paidCharges: paidCharges.toFixed(2), discountAmount: discountAmount.toFixed(2),
        // encargos apurados no pagamento estornado voltam a ser recalculados desde o vencimento/último pagamento restante
        chargesCarried: '0',
        fineApplied: otherPayments.length > 0 ? inst.fineApplied : false,
        lastPaymentAt: lastOther ? lastOther.paidAt : null,
        status: stillPaid ? 'PAID' : otherPayments.length > 0 || paidCharges.gt(0) ? 'PARTIAL' : 'PENDING',
        paidAt: stillPaid ? inst.paidAt : null,
      },
    });
    void openBase;
    if (inst.loan.status === 'PAID') await tx.loan.update({ where: { id: inst.loanId }, data: { status: 'ACTIVE', paidOffAt: null } });
    await addEvent(tx, inst.loanId, 'PAYMENT_REVERSED', ctx, { paymentId: p.id, installment: inst.number, amount: p.amount.toString(), reason });
    await audit(ctx, { action: 'PAYMENT_REVERSE', entity: 'Payment', entityId: p.id, before: { status: 'CONFIRMED' }, after: { status: 'REVERSED', reason } }, tx);
    return tx.payment.findUniqueOrThrow({ where: { id: p.id } });
  });
}

export async function reviewProof(ctx: AuthContext, paymentId: string, decision: 'approve' | 'reject', notes?: string) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.payment.findFirst({ where: { id: paymentId, companyId: ctx.companyId! }, include: { installment: { include: { loan: true } } } });
    if (!p) throw notFound('Comprovante não encontrado');
    if (p.status !== 'PENDING_REVIEW') throw badRequest('Comprovante já conferido');
    if (decision === 'reject') {
      const r = await tx.payment.update({ where: { id: p.id }, data: { status: 'REJECTED', reviewedById: ctx.userId, reviewedAt: new Date(), notes: notes ?? p.notes } });
      await tx.notification.create({ data: { companyId: p.companyId, clientId: p.clientId, title: 'Comprovante não aceito', body: notes ?? 'O comprovante enviado não pôde ser validado. Entre em contato conosco.', link: '/parcelas' } });
      await audit(ctx, { action: 'PAYMENT_PROOF_REJECT', entity: 'Payment', entityId: p.id, after: { notes } }, tx);
      return r;
    }
    const inst = p.installment;
    if (!['PENDING', 'PARTIAL'].includes(inst.status)) throw badRequest('Parcela não está mais em aberto');
    const balance = computeBalance(inst, inst.loan, p.paidAt);
    let alloc;
    try { alloc = allocatePayment(balance, p.amount, 0); } catch (e) { throw badRequest(`Valor do comprovante incompatível com o saldo: ${(e as Error).message}`); }
    const receiptNumber = await nextNumber(tx, p.companyId, 'RECEIPT');
    const confirmed = await tx.payment.update({ where: { id: p.id }, data: { status: 'CONFIRMED', receiptNumber, reviewedById: ctx.userId, reviewedAt: new Date(), receivedById: ctx.userId, receivedByName: ctx.userName, principalPortion: alloc.principalPortion.toFixed(2), interestPortion: alloc.interestPortion.toFixed(2), chargesPortion: alloc.chargesPortion.toFixed(2), notes: notes ?? p.notes } });
    await applyPaymentToInstallment(tx, inst, balance, alloc, p.paidAt, ZERO);
    await addEvent(tx, inst.loanId, 'PAYMENT', ctx, { paymentId: p.id, installment: inst.number, amount: p.amount.toString(), source: 'CLIENT_UPLOAD' });
    await afterPaymentConfirmed(tx, inst, ctx);
    await tx.notification.create({ data: { companyId: p.companyId, clientId: p.clientId, title: 'Pagamento confirmado', body: `Recebemos o pagamento de ${formatBRL(p.amount)} referente à parcela ${inst.number}.`, link: '/pagamentos' } });
    await audit(ctx, { action: 'PAYMENT_PROOF_APPROVE', entity: 'Payment', entityId: p.id, after: { receiptNumber } }, tx);
    return confirmed;
  });
}

// ---------- Quitação antecipada ----------

export async function payoffPreview(companyId: string, loanId: string, asOfIso?: string) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, companyId }, include: { installments: { where: { status: { in: ['PENDING', 'PARTIAL'] } }, orderBy: { number: 'asc' } } } });
  if (!loan) throw notFound('Empréstimo não encontrado');
  if (loan.status !== 'ACTIVE') throw badRequest('Somente empréstimos em andamento podem ser quitados');
  const asOf = asOfIso ? dateOnly(asOfIso) : todayIn(await companyTimezone(companyId));
  const pd = periodDays(loan.periodicity);
  const items = loan.installments.map((i) => ({ installment: i, ...earlyPayoffAmount(i, loan, asOf, pd) }));
  return {
    loan, asOf,
    items,
    totals: {
      principal: sum(items.map((x) => x.principal)),
      interest: sum(items.map((x) => x.interest)),
      charges: sum(items.map((x) => x.charges)),
      waivedInterest: sum(items.map((x) => x.waivedInterest)),
      total: sum(items.map((x) => x.total)),
    },
  };
}

export async function payoffLoan(ctx: AuthContext, loanId: string, input: { paidAt: string; method: PaymentInput['method']; extraDiscount?: string; notes?: string }) {
  const extra = cents(input.extraDiscount ?? 0);
  if (extra.gt(0) && !ctx.permissions.has('discounts.grant') && ctx.role !== 'COMPANY_ADMIN') throw forbidden('Sem permissão para conceder desconto');
  const preview = await payoffPreview(ctx.companyId!, loanId, input.paidAt);
  if (extra.gt(preview.totals.total)) throw badRequest('Desconto maior que o saldo');
  const paidAt = dateOnly(input.paidAt);
  return prisma.$transaction(async (tx) => {
    let discountLeft = extra;
    const payments = [];
    for (const item of preview.items) {
      const inst = item.installment;
      const bal = computeBalance(inst, preview.loan, paidAt);
      // desconto: juros dispensados (pro rata) + desconto adicional distribuído nas últimas parcelas
      const extraHere = Decimal_min(discountLeft, item.total);
      discountLeft = discountLeft.minus(extraHere);
      const discount = item.waivedInterest.plus(extraHere);
      const amount = item.total.minus(extraHere);
      const alloc = allocatePayment(bal, amount, discount);
      const receiptNumber = await nextNumber(tx, ctx.companyId!, 'RECEIPT');
      const p = await tx.payment.create({ data: { companyId: ctx.companyId!, loanId, installmentId: inst.id, clientId: preview.loan.clientId, receiptNumber, amount: amount.toFixed(2), principalPortion: alloc.principalPortion.toFixed(2), interestPortion: alloc.interestPortion.toFixed(2), chargesPortion: alloc.chargesPortion.toFixed(2), discountAmount: discount.toFixed(2), method: input.method, status: 'CONFIRMED', source: 'PAYOFF', paidAt, receivedById: ctx.userId, receivedByName: ctx.userName, notes: input.notes ?? 'Quitação antecipada' } });
      await applyPaymentToInstallment(tx, inst, bal, alloc, paidAt, discount);
      payments.push(p);
    }
    await addEvent(tx, loanId, 'PAID_OFF', ctx, { total: preview.totals.total.minus(extra).toFixed(2), waivedInterest: preview.totals.waivedInterest.toFixed(2), extraDiscount: extra.toFixed(2) });
    await tx.loan.update({ where: { id: loanId }, data: { status: 'PAID', paidOffAt: new Date() } });
    await tx.reminder.updateMany({ where: { installment: { loanId }, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelReason: 'Quitação antecipada' } });
    await tx.charge.updateMany({ where: { installment: { loanId }, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    await audit(ctx, { action: 'LOAN_PAYOFF', entity: 'Loan', entityId: loanId, after: { total: preview.totals.total.minus(extra).toFixed(2), payments: payments.length } }, tx);
    return { payments, total: preview.totals.total.minus(extra).toFixed(2) };
  });
}

const Decimal_min = (a: Dec, b: Dec) => (a.lt(b) ? a : b);

// ---------- Renegociação ----------

export const renegotiationSchema = z.object({
  installmentIds: z.array(zId).min(1),
  discount: zDecimal.default('0'),
  asOf: zDate,
  newLoan: loanInputSchema.omit({ clientId: true, requestedAmount: true }).extend({ requestedAmount: zDecimal.optional() }),
  notes: z.string().optional().nullable(),
});

export async function renegotiationPreview(companyId: string, loanId: string, installmentIds: string[], asOfIso: string, discount: string) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, companyId }, include: { installments: { where: { id: { in: installmentIds }, status: { in: ['PENDING', 'PARTIAL'] } } } } });
  if (!loan) throw notFound('Empréstimo não encontrado');
  if (loan.status !== 'ACTIVE') throw badRequest('Somente empréstimos em andamento podem ser renegociados');
  if (loan.installments.length !== installmentIds.length) throw badRequest('Uma ou mais parcelas não estão em aberto');
  const asOf = dateOnly(asOfIso);
  const balances = loan.installments.map((i) => ({ installment: i, balance: computeBalance(i, loan, asOf) }));
  const balanceBefore = sum(balances.map((b) => b.balance.totalDue));
  const disc = cents(discount);
  if (disc.gt(balanceBefore)) throw badRequest('Desconto maior que o saldo renegociado');
  return { loan, balances, balanceBefore, discount: disc, balanceRenegotiated: balanceBefore.minus(disc) };
}

export async function renegotiate(ctx: AuthContext, loanId: string, input: z.infer<typeof renegotiationSchema>) {
  const disc = cents(input.discount);
  if (disc.gt(0) && !ctx.permissions.has('discounts.grant') && ctx.role !== 'COMPANY_ADMIN') throw forbidden('Sem permissão para conceder desconto');
  const preview = await renegotiationPreview(ctx.companyId!, loanId, input.installmentIds, input.asOf, input.discount);
  const asOf = dateOnly(input.asOf);
  return prisma.$transaction(async (tx) => {
    // 1) as parcelas originais são encerradas como RENEGOTIATED com um lançamento de baixa (fonte RENEGOTIATION), sem receita
    for (const { installment: inst, balance } of preview.balances) {
      const alloc = allocatePayment(balance, 0, balance.totalDue);
      await tx.payment.create({ data: { companyId: ctx.companyId!, loanId, installmentId: inst.id, clientId: preview.loan.clientId, amount: '0', principalPortion: '0', interestPortion: '0', chargesPortion: '0', discountAmount: balance.totalDue.toFixed(2), method: 'OTHER', status: 'CONFIRMED', source: 'RENEGOTIATION', paidAt: asOf, receivedById: ctx.userId, receivedByName: ctx.userName, notes: 'Saldo transferido para renegociação' } });
      void alloc;
      await tx.installment.update({ where: { id: inst.id }, data: { status: 'RENEGOTIATED', chargesCarried: '0' } });
      await tx.reminder.updateMany({ where: { installmentId: inst.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelReason: 'Parcela renegociada' } });
      await tx.charge.updateMany({ where: { installmentId: inst.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    }
    // 2) novo empréstimo com o saldo renegociado como principal (sem novos encargos de abertura por padrão)
    const newLoan = await createLoan(ctx, { ...input.newLoan, clientId: preview.loan.clientId, requestedAmount: preview.balanceRenegotiated.toFixed(2), chargeMode: 'FINANCED', originationFee: input.newLoan.originationFee ?? '0', notes: input.notes ?? `Renegociação do empréstimo nº ${preview.loan.number}` }, { parentLoanId: loanId, source: 'RENEGOTIATION', tx });
    await tx.loan.update({ where: { id: newLoan.id }, data: { status: 'ACTIVE', approvedAt: new Date(), approvedById: ctx.userId, disbursedAt: asOf, disbursedAmount: '0' } });
    await addEvent(tx, newLoan.id, 'DISBURSED', ctx, { notes: 'Renegociação: sem desembolso de novo valor' });
    const remainingOpen = await tx.installment.count({ where: { loanId, status: { in: ['PENDING', 'PARTIAL'] } } });
    if (remainingOpen === 0) await tx.loan.update({ where: { id: loanId }, data: { status: 'RENEGOTIATED' } });
    await tx.installment.updateMany({ where: { id: { in: input.installmentIds } }, data: { renegotiatedIntoLoanId: newLoan.id } });
    const reneg = await tx.renegotiation.create({ data: { companyId: ctx.companyId!, originalLoanId: loanId, newLoanId: newLoan.id, installmentIds: input.installmentIds, balanceBefore: preview.balanceBefore.toFixed(2), discount: disc.toFixed(2), balanceRenegotiated: preview.balanceRenegotiated.toFixed(2), notes: input.notes ?? null, createdById: ctx.userId } });
    await addEvent(tx, loanId, 'RENEGOTIATED', ctx, { newLoanId: newLoan.id, newLoanNumber: newLoan.number, balanceBefore: preview.balanceBefore.toFixed(2), discount: disc.toFixed(2) });
    await audit(ctx, { action: 'LOAN_RENEGOTIATE', entity: 'Renegotiation', entityId: reneg.id, after: reneg }, tx);
    return { renegotiation: reneg, newLoan };
  });
}

// ---------- Recibo ----------

export async function receiptPdf(companyId: string, paymentId: string) {
  const p = await prisma.payment.findFirst({ where: { id: paymentId, companyId }, include: { installment: true, loan: true, client: true, company: true } });
  if (!p) throw notFound('Pagamento não encontrado');
  if (p.status !== 'CONFIRMED') throw badRequest('Recibo disponível apenas para pagamentos confirmados');
  const settings = (p.company.settings ?? {}) as { receiptFooter?: string };
  const METHOD: Record<string, string> = { PIX: 'Pix', BOLETO: 'Boleto', CASH: 'Dinheiro', TRANSFER: 'Transferência', CARD: 'Cartão', OTHER: 'Outro' };
  return renderPdf([
    { type: 'title', text: `RECIBO Nº ${p.receiptNumber}` },
    { type: 'paragraph', text: `${p.company.legalName ?? p.company.name}${p.company.cnpj ? `, CNPJ ${maskDoc(p.company.cnpj)}` : ''}, declara ter recebido de ${p.client.name}, ${p.client.personType === 'PJ' ? 'CNPJ' : 'CPF'} ${maskDoc(p.client.document)}, a importância de ${formatBRL(p.amount)} referente à parcela ${p.installment.number} de ${p.loan.installmentsCount} do empréstimo nº ${p.loan.number}, com vencimento em ${formatBRDate(p.installment.dueDate)}.` },
    { type: 'kv', rows: [['Data do pagamento', formatBRDate(p.paidAt)], ['Forma de pagamento', METHOD[p.method]], ['Valor recebido', formatBRL(p.amount)], ['Destinação — principal', formatBRL(p.principalPortion)], ['Destinação — juros', formatBRL(p.interestPortion)], ['Destinação — encargos de atraso', formatBRL(p.chargesPortion)], ['Desconto concedido', formatBRL(p.discountAmount)], ['Recebido por', p.receivedByName ?? '—'], ['Emitido em', formatBRDate(new Date())]] },
    ...(p.notes ? [{ type: 'small' as const, text: `Observações: ${p.notes}` }] : []),
    { type: 'small', text: `Identificador: ${p.id}` },
  ], { title: `Recibo ${p.receiptNumber}`, header: p.company.name, footer: settings.receiptFooter ?? 'Documento emitido eletronicamente.' });
}

export type { Prisma };
