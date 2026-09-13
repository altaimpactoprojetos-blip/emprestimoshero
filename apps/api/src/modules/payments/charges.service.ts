import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { computeBalance } from '../../domain/installment.js';
import { todayIn } from '../../lib/dates.js';
import { paymentProvider, normalizeEvent, type NormalizedEvent } from '../../services/payments-provider.js';
import type { AuthContext } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { registerPayment } from './payments.service.js';
import { systemContext } from '../../lib/system.js';
import { D } from '../../lib/money.js';

export async function createCharge(ctx: AuthContext, installmentId: string, type: 'PIX' | 'BOLETO') {
  const companyId = ctx.companyId!;
  const inst = await prisma.installment.findFirst({ where: { id: installmentId, companyId }, include: { loan: { include: { client: true, company: true } } } });
  if (!inst) throw notFound('Parcela não encontrada');
  if (inst.loan.status !== 'ACTIVE' || !['PENDING', 'PARTIAL'].includes(inst.status)) throw badRequest('Parcela não está em aberto');
  const existing = await prisma.charge.findFirst({ where: { installmentId, status: 'PENDING', type } });
  if (existing) return existing;
  const today = todayIn(inst.loan.company.timezone);
  const balance = computeBalance(inst, inst.loan, today);
  const dueDate = balance.daysLate > 0 ? new Date(Date.now() + 3 * 86400000) : inst.dueDate;
  try {
    const r = await paymentProvider.createCharge({ installmentId, type, amount: balance.totalDue.toFixed(2), dueDate, payer: { name: inst.loan.client.name, document: inst.loan.client.document, email: inst.loan.client.email }, description: `Parcela ${inst.number}/${inst.loan.installmentsCount} - contrato ${inst.loan.number}` });
    const charge = await prisma.charge.create({ data: { companyId, installmentId, provider: paymentProvider.name, externalId: r.externalId, type, amount: balance.totalDue.toFixed(2), payload: r.payload, expiresAt: r.expiresAt } });
    await audit(ctx, { action: 'CHARGE_CREATE', entity: 'Charge', entityId: charge.id, after: { installmentId, type, amount: charge.amount } });
    return charge;
  } catch (e) {
    await prisma.integrationIssue.create({ data: { companyId, kind: 'CHARGE_CREATE', reference: installmentId, message: `Falha ao emitir cobrança ${type}: ${(e as Error).message}` } });
    throw badRequest(`Falha na integração com o provedor: ${(e as Error).message}`);
  }
}

/**
 * Processa um evento de webhook já autenticado. Idempotente: cada externalEventId é processado uma única vez,
 * mesmo com reenvios do provedor.
 */
export async function processPaymentEvent(provider: string, body: unknown): Promise<{ status: string; detail?: string }> {
  let ev: NormalizedEvent;
  try { ev = normalizeEvent(provider, body); } catch (e) { return { status: 'IGNORED', detail: (e as Error).message }; }
  if (!ev.eventId) return { status: 'IGNORED', detail: 'Evento sem identificador' };
  let record;
  try {
    record = await prisma.webhookEvent.create({ data: { provider, externalEventId: ev.eventId, eventType: ev.type, payload: ev.raw as never } });
  } catch {
    return { status: 'DUPLICATE' };
  }
  try {
    const charge = await prisma.charge.findUnique({ where: { provider_externalId: { provider, externalId: ev.externalChargeId } }, include: { installment: { include: { loan: true } } } });
    if (!charge) {
      await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: 'IGNORED', error: 'Cobrança desconhecida', processedAt: new Date() } });
      return { status: 'IGNORED', detail: 'Cobrança desconhecida' };
    }
    const ctx = systemContext(charge.companyId, `Webhook ${provider}`);
    if (ev.type === 'charge.paid') {
      if (charge.status === 'PAID') {
        await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: 'IGNORED', error: 'Cobrança já baixada', processedAt: new Date() } });
        return { status: 'IGNORED', detail: 'Cobrança já baixada' };
      }
      const paidAmount = D(ev.amount ?? charge.amount);
      const inst = charge.installment;
      const paidAt = ev.paidAt ? ev.paidAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
      const balance = computeBalance(inst, inst.loan, new Date(paidAt + 'T00:00:00Z'));
      const applicable = paidAmount.gt(balance.totalDue) ? balance.totalDue : paidAmount;
      if (!['PENDING', 'PARTIAL'].includes(inst.status) || inst.loan.status !== 'ACTIVE' || applicable.lte(0)) {
        await prisma.integrationIssue.create({ data: { companyId: charge.companyId, kind: 'PAYMENT_WEBHOOK', reference: charge.id, message: `Pagamento de ${paidAmount.toFixed(2)} recebido para parcela que não está em aberto (parcela ${inst.number}, contrato ${inst.loan.number}). Verifique e trate manualmente.`, details: ev.raw as never } });
        await prisma.charge.update({ where: { id: charge.id }, data: { status: 'PAID', paidAt: new Date(), feeAmount: ev.feeAmount ?? null, netAmount: ev.netAmount ?? null } });
        await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: 'PROCESSED', error: 'Parcela não estava em aberto; pendência registrada', processedAt: new Date() } });
        return { status: 'PROCESSED', detail: 'Pendência registrada' };
      }
      await prisma.$transaction(async (tx) => {
        await registerPayment(ctx, { installmentId: inst.id, amount: applicable.toFixed(2), discount: '0', method: charge.type === 'PIX' ? 'PIX' : 'BOLETO', paidAt, notes: `Confirmado pelo provedor ${provider} (evento ${ev.eventId})`, chargeId: charge.id, source: 'PROVIDER' }, { tx, receivedByName: `Provedor ${provider}` });
        await tx.charge.update({ where: { id: charge.id }, data: { status: 'PAID', paidAt: ev.paidAt ? new Date(ev.paidAt) : new Date(), feeAmount: ev.feeAmount ?? null, netAmount: ev.netAmount ?? null } });
        if (paidAmount.gt(balance.totalDue)) await tx.integrationIssue.create({ data: { companyId: charge.companyId, kind: 'PAYMENT_WEBHOOK', reference: charge.id, message: `Valor recebido (${paidAmount.toFixed(2)}) maior que o saldo da parcela (${balance.totalDue.toFixed(2)}). Diferença de ${paidAmount.minus(balance.totalDue).toFixed(2)} a tratar.`, details: ev.raw as never } });
        if (paidAmount.lt(charge.amount)) await tx.integrationIssue.create({ data: { companyId: charge.companyId, kind: 'PAYMENT_WEBHOOK', reference: charge.id, message: `Valor recebido (${paidAmount.toFixed(2)}) menor que o valor da cobrança (${charge.amount}). Registrado como pagamento parcial.`, details: ev.raw as never } });
        await tx.notification.create({ data: { companyId: charge.companyId, clientId: inst.loan.clientId, title: 'Pagamento confirmado', body: `Recebemos ${applicable.toFixed(2).replace('.', ',')} referente à parcela ${inst.number} do contrato nº ${inst.loan.number}. Obrigado.`, link: '/pagamentos' } });
        await tx.webhookEvent.update({ where: { id: record.id }, data: { status: 'PROCESSED', processedAt: new Date() } });
      });
      return { status: 'PROCESSED' };
    }
    if (ev.type === 'charge.expired' || ev.type === 'charge.cancelled' || ev.type === 'charge.failed') {
      if (charge.status === 'PENDING') await prisma.charge.update({ where: { id: charge.id }, data: { status: ev.type === 'charge.expired' ? 'EXPIRED' : ev.type === 'charge.failed' ? 'FAILED' : 'CANCELLED', lastError: ev.type === 'charge.failed' ? JSON.stringify(ev.raw).slice(0, 500) : null } });
      if (ev.type === 'charge.failed') await prisma.integrationIssue.create({ data: { companyId: charge.companyId, kind: 'PAYMENT_WEBHOOK', reference: charge.id, message: 'Provedor informou falha na cobrança', details: ev.raw as never } });
      await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: 'PROCESSED', processedAt: new Date() } });
      return { status: 'PROCESSED' };
    }
    await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: 'IGNORED', error: `Tipo não tratado: ${ev.type}`, processedAt: new Date() } });
    return { status: 'IGNORED', detail: ev.type };
  } catch (e) {
    await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: 'FAILED', error: (e as Error).message, processedAt: new Date() } });
    const charge = await prisma.charge.findUnique({ where: { provider_externalId: { provider, externalId: ev.externalChargeId } } });
    if (charge) await prisma.integrationIssue.create({ data: { companyId: charge.companyId, kind: 'PAYMENT_WEBHOOK', reference: charge.id, message: `Erro ao processar evento ${ev.eventId}: ${(e as Error).message}`, details: ev.raw as never } });
    return { status: 'FAILED', detail: (e as Error).message };
  }
}

export async function reconciliation(companyId: string, from?: string, to?: string) {
  const range = from || to ? { gte: from ? new Date(from) : undefined, lte: to ? new Date(`${to}T23:59:59Z`) : undefined } : undefined;
  const charges = await prisma.charge.findMany({ where: { companyId, ...(range ? { createdAt: range } : {}) }, include: { installment: { select: { number: true, dueDate: true, loan: { select: { id: true, number: true, client: { select: { id: true, name: true } } } } } }, payments: { select: { id: true, amount: true, status: true, receiptNumber: true } } }, orderBy: { createdAt: 'desc' }, take: 2000 });
  const sum = (arr: typeof charges, f: (c: (typeof charges)[number]) => string | null | undefined) => arr.reduce((a, c) => a.plus(f(c) ?? 0), D(0));
  const paid = charges.filter((c) => c.status === 'PAID');
  return {
    charges,
    totals: {
      issued: { count: charges.length, amount: sum(charges, (c) => c.amount.toString()).toFixed(2) },
      paid: { count: paid.length, amount: sum(paid, (c) => c.amount.toString()).toFixed(2), fees: sum(paid, (c) => c.feeAmount?.toString()).toFixed(2), net: sum(paid, (c) => (c.netAmount ?? c.amount)?.toString()).toFixed(2) },
      pending: { count: charges.filter((c) => c.status === 'PENDING').length, amount: sum(charges.filter((c) => c.status === 'PENDING'), (c) => c.amount.toString()).toFixed(2) },
      other: { count: charges.filter((c) => !['PAID', 'PENDING'].includes(c.status)).length },
    },
  };
}
