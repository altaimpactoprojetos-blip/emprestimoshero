import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { addDays, addMonths } from 'date-fns';

/**
 * Dados de negócio de demonstração (clientes, produto, empréstimos e parcelas).
 * Todos os registros são fictícios; CPFs abaixo são válidos apenas no dígito verificador.
 */
export async function seedBusiness(prisma: PrismaClient, companyId: string) {
  const existing = await prisma.client.count({ where: { companyId } });
  if (existing > 0) return;
  const { createLoan, transition } = await import('../src/modules/loans/loans.service.js');
  const { registerPayment } = await import('../src/modules/payments/payments.service.js').catch(() => ({ registerPayment: null as null | ((...a: never[]) => Promise<unknown>) }));
  const admin = await prisma.user.findFirstOrThrow({ where: { companyId, role: 'COMPANY_ADMIN' } });
  const ctx = { userId: admin.id, userName: admin.name, role: 'COMPANY_ADMIN' as const, companyId, clientId: null, permissions: new Set<string>(), ip: null };

  const product = await prisma.loanProduct.create({
    data: { companyId, name: 'Crédito pessoal (demonstração)', calcMethod: 'PRICE', monthlyRate: 4.5, originationFee: 30, iofFixedRate: 0.38, iofDailyRate: 0.0082, chargeMode: 'DEDUCTED', lateFineRate: 2, lateInterestMonthly: 1, legallyReviewed: true, legalNotes: 'Condições revisadas juridicamente para fins de demonstração.' },
  });

  const clientsData = [
    { name: 'Maria Oliveira (demonstração)', document: '11144477735', email: 'maria@cliente.local', phone: '11987654321', addressCity: 'São Paulo', addressState: 'SP' },
    { name: 'João Pereira (demonstração)', document: '52998224725', email: 'joao@cliente.local', phone: '21998765432', addressCity: 'Rio de Janeiro', addressState: 'RJ' },
    { name: 'Comercial Silva Ltda (demonstração)', document: '11222333000181', personType: 'PJ' as const, email: 'financeiro@silva.local', phone: '3133334444', addressCity: 'Belo Horizonte', addressState: 'MG' },
    { name: 'Carlos Souza (demonstração)', document: '39053344705', email: 'carlos@cliente.local', phone: '41999998888', addressCity: 'Curitiba', addressState: 'PR' },
  ];
  const clients = [];
  for (const c of clientsData) clients.push(await prisma.client.create({ data: { companyId, personType: 'PF', ...c } }));

  // acesso ao portal para a primeira cliente
  await prisma.user.create({ data: { companyId, clientId: clients[0].id, name: clients[0].name, email: clients[0].email!, role: 'CLIENT', passwordHash: await bcrypt.hash('Senha@123', 10) } });

  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const common = { productId: product.id, calcMethod: 'PRICE' as const, monthlyRate: '4.5', chargeMode: 'DEDUCTED' as const, originationFee: '30', originationFeeRate: '0', iofFixedRate: '0.38', iofDailyRate: '0.0082', lateFineRate: '2', lateInterestMonthly: '1', periodicity: 'MONTHLY' as const };

  // 1) Empréstimo ativo com parcelas vencidas (liberado há 4 meses)
  const l1 = await createLoan(ctx, { ...common, clientId: clients[0].id, requestedAmount: '5000', installmentsCount: 10, disbursementDate: iso(addMonths(today, -4)), firstDueDate: iso(addMonths(today, -3)), notes: 'Dados de demonstração' });
  await transition(ctx, l1.id, 'approve', { notes: 'Renda comprovada; aprovado (demonstração)' });
  await transition(ctx, l1.id, 'disburse', { date: iso(addMonths(today, -4)) });

  // 2) Empréstimo ativo em dia (SAC)
  const l2 = await createLoan(ctx, { ...common, calcMethod: 'SAC', clientId: clients[2].id, requestedAmount: '20000', installmentsCount: 12, disbursementDate: iso(addDays(today, -20)), firstDueDate: iso(addDays(today, 10)), notes: 'Capital de giro (demonstração)' });
  await transition(ctx, l2.id, 'approve', {});
  await transition(ctx, l2.id, 'disburse', { date: iso(addDays(today, -20)) });

  // 3) Empréstimo com parcela vencendo hoje
  const l3 = await createLoan(ctx, { ...common, clientId: clients[1].id, requestedAmount: '3000', installmentsCount: 6, periodicity: 'BIWEEKLY', disbursementDate: iso(addDays(today, -15)), firstDueDate: iso(today) });
  await transition(ctx, l3.id, 'approve', {});
  await transition(ctx, l3.id, 'disburse', { date: iso(addDays(today, -15)) });

  // 4) Proposta em avaliação
  const l4 = await createLoan(ctx, { ...common, clientId: clients[3].id, requestedAmount: '8000', installmentsCount: 8, disbursementDate: iso(today), firstDueDate: iso(addMonths(today, 1)) });
  await transition(ctx, l4.id, 'submit', {});

  // pagamentos de demonstração (quando o módulo estiver disponível)
  if (registerPayment) {
    const inst = await prisma.installment.findMany({ where: { loanId: l1.id }, orderBy: { number: 'asc' } });
    await (registerPayment as never as (ctx: unknown, input: unknown) => Promise<unknown>)(ctx, { installmentId: inst[0].id, amount: inst[0].originalAmount.toString(), method: 'PIX', paidAt: iso(inst[0].dueDate), notes: 'Pagamento de demonstração' });
    await (registerPayment as never as (ctx: unknown, input: unknown) => Promise<unknown>)(ctx, { installmentId: inst[1].id, amount: '200', method: 'CASH', paidAt: iso(addDays(inst[1].dueDate, 5)), notes: 'Pagamento parcial de demonstração' });
  }
}
