import { describe, it, expect, beforeAll } from 'vitest';
import { setupDb, createCompanyWithAdmin, makeApp, login, agent } from './helpers.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (days: number, from = new Date()) => { const d = new Date(from); d.setUTCDate(d.getUTCDate() + days); return d; };
const H = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('parcelas, pagamentos, estorno, quitação, renegociação e contratos', () => {
  let app: ReturnType<typeof agent>;
  let token: string;
  let tokenB: string;
  let clientId: string;

  const newActiveLoan = async (overrides: Record<string, unknown> = {}) => {
    const created = await app.post('/api/loans').set(H(token)).send({ clientId, requestedAmount: '1000', installmentsCount: 3, disbursementDate: iso(plus(-70)), firstDueDate: iso(plus(-40)), calcMethod: 'PRICE', monthlyRate: '5', lateFineRate: '2', lateInterestMonthly: '1', ...overrides });
    expect(created.status).toBe(201);
    await app.post(`/api/loans/${created.body.id}/approve`).set(H(token)).send({});
    const d = await app.post(`/api/loans/${created.body.id}/disburse`).set(H(token)).send({ date: iso(plus(-70)) });
    expect(d.body.status).toBe('ACTIVE');
    return (await app.get(`/api/loans/${created.body.id}`).set(H(token))).body;
  };

  beforeAll(async () => {
    await setupDb();
    await createCompanyWithAdmin('alfa');
    await createCompanyWithAdmin('beta');
    app = agent(await makeApp());
    token = await login(app, 'admin@alfa.local');
    tokenB = await login(app, 'admin@beta.local');
    const c = await app.post('/api/clients').set(H(token)).send({ name: 'Cliente Teste', document: '111.444.777-35', email: 'c@x.local' });
    clientId = c.body.id;
  });

  it('pagamento parcial e integral com destinação encargos → juros → principal; recibo; lembretes cancelados', async () => {
    const loan = await newActiveLoan();
    const inst1 = loan.installments[0]; // vencida há 40 dias
    expect(inst1.balance.displayStatus).toBe('OVERDUE');
    expect(Number(inst1.balance.chargesDue)).toBeGreaterThan(0);
    // lembrete agendado que deve ser cancelado na quitação
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.reminder.create({ data: { companyId: loan.companyId, installmentId: inst1.id, clientId, offsetDays: 7, channel: 'EMAIL', dedupeKey: `${inst1.id}:7:EMAIL`, scheduledFor: new Date() } });

    const partial = await app.post('/api/payments').set(H(token)).send({ installmentId: inst1.id, amount: '100', method: 'PIX', paidAt: iso(new Date()) });
    expect(partial.status).toBe(201);
    expect(Number(partial.body.chargesPortion)).toBeCloseTo(Number(inst1.balance.chargesDue), 2);
    expect(Number(partial.body.chargesPortion) + Number(partial.body.interestPortion) + Number(partial.body.principalPortion)).toBeCloseTo(100, 2);
    let d = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    expect(d.installments[0].status).toBe('PARTIAL');
    expect(d.installments[0].balance.displayStatus).toBe('OVERDUE');
    expect(Number(d.installments[0].balance.totalDue)).toBeCloseTo(Number(inst1.balance.totalDue) - 100, 2);
    // excesso é rejeitado
    const over = await app.post('/api/payments').set(H(token)).send({ installmentId: inst1.id, amount: '99999', method: 'PIX', paidAt: iso(new Date()) });
    expect(over.status).toBe(400);
    // integral do restante
    const rest = d.installments[0].balance.totalDue;
    const full = await app.post('/api/payments').set(H(token)).send({ installmentId: inst1.id, amount: rest, method: 'CASH', paidAt: iso(new Date()) });
    expect(full.status).toBe(201);
    expect(full.body.receiptNumber).toBeGreaterThan(0);
    d = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    expect(d.installments[0].status).toBe('PAID');
    expect(Number(d.installments[0].balance.totalDue)).toBe(0);
    const rem = await prisma.reminder.findFirst({ where: { installmentId: inst1.id } });
    expect(rem?.status).toBe('CANCELLED');
    const receipt = await app.get(`/api/payments/${full.body.id}/receipt`).set(H(token));
    expect(receipt.status).toBe(200);
    expect(receipt.headers['content-type']).toContain('pdf');
    // empresa B não vê o pagamento
    expect((await app.get(`/api/payments/${full.body.id}/receipt`).set(H(tokenB))).status).toBe(404);
  });

  it('estorno justificado preserva o pagamento original e reabre a parcela', async () => {
    const loan = await newActiveLoan();
    const inst = loan.installments[1];
    const before = inst.balance.totalDue;
    const pay = await app.post('/api/payments').set(H(token)).send({ installmentId: inst.id, amount: before, method: 'PIX', paidAt: iso(new Date()) });
    expect(pay.status).toBe(201);
    let d = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    expect(d.installments[1].status).toBe('PAID');
    expect((await app.post(`/api/payments/${pay.body.id}/reverse`).set(H(token)).send({ reason: 'x' })).status).toBe(400);
    const rev = await app.post(`/api/payments/${pay.body.id}/reverse`).set(H(token)).send({ reason: 'Valor creditado em conta errada' });
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe('REVERSED');
    d = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    expect(d.installments[1].status).toBe('PENDING');
    expect(d.installments[1].balance.totalDue).toBe(before);
    expect(d.payments.length).toBe(1);
    expect(d.payments[0].status).toBe('REVERSED');
    expect(Number(d.summary.totalPaid)).toBe(0);
  });

  it('quitação antecipada cobra juros pro rata das parcelas a vencer e encerra o empréstimo', async () => {
    const loan = await newActiveLoan({ disbursementDate: iso(plus(-10)), firstDueDate: iso(plus(20)) });
    const preview = await app.get(`/api/payments/payoff/${loan.id}`).set(H(token));
    expect(preview.status).toBe(200);
    expect(Number(preview.body.totals.principal)).toBe(1000);
    expect(Number(preview.body.totals.waivedInterest)).toBeGreaterThan(0);
    expect(Number(preview.body.totals.total)).toBeLessThan(Number(loan.totalAmount));
    const payoff = await app.post(`/api/payments/payoff/${loan.id}`).set(H(token)).send({ paidAt: iso(new Date()), method: 'PIX' });
    expect(payoff.status).toBe(200);
    const d = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    expect(d.status).toBe('PAID');
    expect(d.installments.every((i: { status: string }) => i.status === 'PAID')).toBe(true);
    expect(Number(d.summary.principalPaid)).toBe(1000);
    expect(Number(d.summary.totalPaid)).toBeCloseTo(Number(preview.body.totals.total), 2);
  });

  it('renegociação transfere o saldo sem duplicar a dívida', async () => {
    const loan = await newActiveLoan();
    const open = loan.installments.filter((i: { status: string }) => i.status === 'PENDING');
    const asOf = iso(new Date());
    const preview = await app.post(`/api/payments/renegotiate/${loan.id}/preview`).set(H(token)).send({ installmentIds: open.map((i: { id: string }) => i.id), asOf, discount: '50' });
    expect(preview.status).toBe(200);
    const balanceBefore = Number(preview.body.balanceBefore);
    expect(balanceBefore).toBeCloseTo(Number(loan.summary.openBalance), 1);
    const r = await app.post(`/api/payments/renegotiate/${loan.id}`).set(H(token)).send({ installmentIds: open.map((i: { id: string }) => i.id), asOf, discount: '50', newLoan: { installmentsCount: 6, periodicity: 'MONTHLY', disbursementDate: asOf, firstDueDate: iso(plus(30)), calcMethod: 'PRICE', monthlyRate: '3', chargeMode: 'FINANCED', originationFee: '0', originationFeeRate: '0', iofFixedRate: '0', iofDailyRate: '0', lateFineRate: '2', lateInterestMonthly: '1' } });
    expect(r.status).toBe(201);
    const oldLoan = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    const newLoan = (await app.get(`/api/loans/${r.body.newLoan.id}`).set(H(token))).body;
    expect(oldLoan.status).toBe('RENEGOTIATED');
    expect(Number(oldLoan.summary.openBalance)).toBe(0);
    expect(oldLoan.installments.every((i: { status: string }) => i.status === 'RENEGOTIATED')).toBe(true);
    expect(newLoan.status).toBe('ACTIVE');
    expect(Number(newLoan.principalAmount)).toBeCloseTo(balanceBefore - 50, 2);
    expect(newLoan.installments).toHaveLength(6);
    // o cliente deve ter apenas o saldo do novo empréstimo
    const client = (await app.get(`/api/clients/${clientId}`).set(H(token))).body;
    const activeLoans = client.loans.filter((l: { status: string }) => l.status === 'ACTIVE');
    const sumOpen = activeLoans.reduce((a: number, l: { summary: { openBalance: string } }) => a + Number(l.summary.openBalance), 0);
    expect(sumOpen).toBeCloseTo(Number(newLoan.summary.openBalance) + activeLoans.filter((l: { id: string }) => l.id !== newLoan.id).reduce((a: number, l: { summary: { openBalance: string } }) => a + Number(l.summary.openBalance), 0), 2);
  });

  it('modelos versionados, contrato gerado com PDF/hash, assinatura e vínculo por aditivo', async () => {
    const t = await app.get('/api/contracts/templates').set(H(token));
    const tpl = t.body.templates[0];
    const created = await app.post('/api/loans').set(H(token)).send({ clientId, requestedAmount: '2000', installmentsCount: 2, disbursementDate: iso(new Date()), firstDueDate: iso(plus(30)), calcMethod: 'PRICE', monthlyRate: '4' });
    await app.post(`/api/loans/${created.body.id}/approve`).set(H(token)).send({});
    // modelo não aprovado não gera contrato
    expect((await app.post('/api/contracts/generate').set(H(token)).send({ loanId: created.body.id, templateId: tpl.id })).status).toBe(400);
    expect((await app.post(`/api/contracts/templates/${tpl.id}/approve`).set(H(token)).send({ legalReviewNotes: 'Revisado pelo jurídico' })).status).toBe(200);
    const gen = await app.post('/api/contracts/generate').set(H(token)).send({ loanId: created.body.id, templateId: tpl.id });
    expect(gen.status).toBe(201);
    expect(gen.body.sha256).toHaveLength(64);
    expect(gen.body.status).toBe('DRAFT');
    const pdf = await app.get(`/api/contracts/${gen.body.id}/pdf`).set(H(token));
    expect(pdf.headers['content-type']).toContain('pdf');
    expect((await app.get(`/api/contracts/${gen.body.id}`).set(H(tokenB))).status).toBe(404);
    const detail = await app.get(`/api/contracts/${gen.body.id}`).set(H(token));
    expect(detail.body.html).toContain('Cliente Teste');
    expect(detail.body.renderedContent).toContain('R$');
    expect((await app.post(`/api/contracts/${gen.body.id}/request_signature`).set(H(token)).send({})).body.status).toBe('AWAITING_SIGNATURE');
    expect((await app.get(`/api/loans/${created.body.id}`).set(H(token))).body.status).toBe('AWAITING_SIGNATURE');
    const signed = await app.post(`/api/contracts/${gen.body.id}/simulate-signature`).set(H(token)).send({});
    expect(signed.body.status).toBe('SIGNED');
    const loan = (await app.get(`/api/loans/${created.body.id}`).set(H(token))).body;
    expect(loan.status).toBe('SIGNED');
    expect(loan.events.map((e: { type: string }) => e.type)).toContain('SIGNED');
    // contrato assinado não pode ser cancelado nem as condições alteradas; aditivo é permitido
    expect((await app.post(`/api/contracts/${gen.body.id}/cancel`).set(H(token)).send({})).status).toBe(400);
    expect((await app.put(`/api/loans/${created.body.id}`).set(H(token)).send({ clientId, requestedAmount: '2500', installmentsCount: 2, disbursementDate: iso(new Date()), firstDueDate: iso(plus(30)), calcMethod: 'PRICE', monthlyRate: '4' })).status).toBe(400);
    const add = await app.post('/api/contracts/generate').set(H(token)).send({ loanId: created.body.id, templateId: tpl.id, kind: 'ADDENDUM', parentContractId: gen.body.id, extraText: 'Altera a forma de pagamento.' });
    expect(add.status).toBe(201);
    expect(add.body.parentContractId).toBe(gen.body.id);
    // editar modelo aprovado cria nova versão em rascunho
    const v2 = await app.put(`/api/contracts/templates/${tpl.id}`).set(H(token)).send({ content: tpl.content + '\n\nCláusula extra.' });
    expect(v2.body.version).toBe(2);
    expect(v2.body.status).toBe('DRAFT');
  });
});
