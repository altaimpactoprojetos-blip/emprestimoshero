import { describe, it, expect, beforeAll } from 'vitest';
import { setupDb, createCompanyWithAdmin, makeApp, login, agent } from './helpers.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (days: number, from = new Date()) => { const d = new Date(from); d.setUTCDate(d.getUTCDate() + days); return d; };
const H = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('empréstimos sobre saldo devedor (API)', () => {
  let app: ReturnType<typeof agent>;
  let token: string;
  let tokenB: string;
  let clientId: string;
  let loanId: string;

  beforeAll(async () => {
    await setupDb();
    await createCompanyWithAdmin('gama');
    await createCompanyWithAdmin('delta');
    app = agent(await makeApp());
    token = await login(app, 'admin@gama.local');
    tokenB = await login(app, 'admin@delta.local');
    const c = await app.post('/api/clients').set(H(token)).send({ name: 'Maria Devedora', document: '111.444.777-35', phone: '(11) 98888-7777', rg: '12.345.678-9', maritalStatus: 'casada', profession: 'comerciante', nationality: 'brasileira', addressCity: 'Campinas', addressState: 'SP', notes: 'Indicada pelo João' });
    expect(c.status).toBe(201);
    expect(c.body.rg).toBe('12.345.678-9');
    expect(c.body.profession).toBe('comerciante');
    clientId = c.body.id;
  });

  it('dados do credor e padrões ficam em Configurações', async () => {
    const r = await app.put('/api/lending/settings').set(H(token)).send({ creditor: { name: 'José Credor', cpf: '529.982.247-25', nationality: 'brasileiro', maritalStatus: 'solteiro', profession: 'empresário', address: 'Rua A, 1, Centro', city: 'Campinas', state: 'SP', pixKey: 'jose@pix' }, lending: { pendingInterestMode: 'SEPARATE', lateFineRate: '2', lateInterestMonthly: '1', forumCity: 'Campinas/SP' } });
    expect(r.status).toBe(200);
    expect(r.body.creditor.cpf).toBe('52998224725');
    expect(r.body.lending.lateFineRate).toBe('2');
    const g = await app.get('/api/lending/settings').set(H(token));
    expect(g.body.creditor.name).toBe('José Credor');
  });

  it('simulador: informa valor, taxa e prazo e mostra quanto vai receber', async () => {
    const r = await app.post('/api/lending/simulate').set(H(token)).send({ amount: '1000', ratePct: '10', ratePeriod: 'MONTHLY', startDate: '2026-01-10', maturityDate: '2026-04-10', billingType: 'INTEREST_ONLY' });
    expect(r.status).toBe(200);
    expect(r.body.totalInterest).toBe('300.00');
    expect(r.body.totalToReceive).toBe('1300.00');
    expect(r.body.periods).toHaveLength(3);
  });

  it('cadastra, mostra prévia do pagamento parcial e recalcula (exemplo R$ 1.000 a 10%)', async () => {
    const start = plus(-20);
    const created = await app.post('/api/lending/loans').set(H(token)).send({ clientId, amount: '1000', ratePct: '10', ratePeriod: 'MONTHLY', startDate: iso(start), maturityDate: iso(plus(150, start)), billingType: 'INTEREST_ONLY', disbursementMethod: 'PIX' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('ACTIVE');
    expect(created.body.engine).toBe('BALANCE');
    loanId = created.body.id;

    const preview = await app.post(`/api/lending/loans/${loanId}/payments/preview`).set(H(token)).send({ amount: '400', paidAt: iso(plus(-1)) });
    expect(preview.status).toBe(200);
    expect(preview.body.allocation).toMatchObject({ interest: '100.00', principal: '300.00', principalAfter: '700.00', nextPeriodInterest: '70.00' });
    expect(preview.body.before.balance).toBe('1100.00');

    const paid = await app.post(`/api/lending/loans/${loanId}/payments`).set(H(token)).send({ amount: '400', paidAt: iso(plus(-1)), method: 'PIX' });
    expect(paid.status).toBe(201);
    expect(paid.body.payment.balanceAfter).toBe('700');
    expect(paid.body.payment.interestPortion).toBe('100');

    const d = await app.get(`/api/lending/loans/${loanId}`).set(H(token));
    expect(d.body.ledger.principal).toBe('1000.00');
    expect(d.body.ledger.principalOpen).toBe('700.00');
    expect(d.body.ledger.totalPaid).toBe('400.00');
    expect(d.body.ledger.interestAccrued).toBe('100.00');
    expect(d.body.history).toHaveLength(1);
    expect(d.body.history[0]).toMatchObject({ amount: '400.00', interest: '100.00', principal: '300.00', principalAfter: '700.00', method: 'PIX' });
    // recibo em PDF
    const rec = await app.get(`/api/payments/${paid.body.payment.id}/receipt`).set(H(token));
    expect(rec.status).toBe(200);
    expect(rec.headers['content-type']).toContain('application/pdf');
  });

  it('edita e exclui pagamento lançado errado, recalculando tudo', async () => {
    const extra = await app.post(`/api/lending/loans/${loanId}/payments`).set(H(token)).send({ amount: '50', paidAt: iso(plus(0)), method: 'CASH' });
    expect(extra.body.allocation.principal).toBe('50.00');
    const first = (await app.get(`/api/lending/loans/${loanId}`).set(H(token))).body.history[0];
    const upd = await app.put(`/api/lending/payments/${first.id}`).set(H(token)).send({ amount: '150', paidAt: first.date, method: 'PIX' });
    expect(upd.status).toBe(200);
    expect(upd.body.allocation).toMatchObject({ interest: '100.00', principal: '50.00', principalAfter: '950.00' });
    let d = (await app.get(`/api/lending/loans/${loanId}`).set(H(token))).body;
    expect(d.ledger.principalOpen).toBe('900.00');
    const del = await app.delete(`/api/lending/payments/${extra.body.payment.id}`).set(H(token));
    expect(del.status).toBe(200);
    d = (await app.get(`/api/lending/loans/${loanId}`).set(H(token))).body;
    expect(d.ledger.principalOpen).toBe('950.00');
    expect(d.history).toHaveLength(1);
    // pagamento maior que o saldo é bloqueado
    const tooMuch = await app.post(`/api/lending/loans/${loanId}/payments/preview`).set(H(token)).send({ amount: '5000', paidAt: iso(plus(0)) });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/maior que o saldo/);
    // data futura é bloqueada
    const future = await app.post(`/api/lending/loans/${loanId}/payments/preview`).set(H(token)).send({ amount: '10', paidAt: iso(plus(3)) });
    expect(future.status).toBe(400);
  });

  it('quitação muda a situação para quitado; excluir o pagamento reabre', async () => {
    const d = (await app.get(`/api/lending/loans/${loanId}`).set(H(token))).body;
    const pay = await app.post(`/api/lending/loans/${loanId}/payments`).set(H(token)).send({ amount: d.ledger.balance, paidAt: iso(plus(0)) });
    expect(pay.body.allocation.paysOff).toBe(true);
    let loan = (await app.get(`/api/lending/loans/${loanId}`).set(H(token))).body;
    expect(loan.status).toBe('PAID');
    expect(loan.ledger.status).toBe('PAID');
    await app.delete(`/api/lending/payments/${pay.body.payment.id}`).set(H(token));
    loan = (await app.get(`/api/lending/loans/${loanId}`).set(H(token))).body;
    expect(loan.status).toBe('ACTIVE');
  });

  it('atraso automático, painel com vencimentos e filtros', async () => {
    // vencido há 10 dias, sem pagamento
    const start = plus(-40);
    const late = await app.post('/api/lending/loans').set(H(token)).send({ clientId, amount: '500', ratePct: '10', ratePeriod: 'MONTHLY', startDate: iso(start), maturityDate: iso(plus(120, start)), billingType: 'INTEREST_ONLY' });
    const det = (await app.get(`/api/lending/loans/${late.body.id}`).set(H(token))).body;
    expect(det.ledger.status).toBe('OVERDUE');
    expect(Number(det.ledger.chargesPending)).toBeGreaterThan(0); // multa (padrão das configurações) + mora
    expect(det.lateFineRate).toBe('2');

    const dash = (await app.get('/api/lending/dashboard').set(H(token))).body;
    expect(Number(dash.totals.lent)).toBe(1500);
    expect(dash.overdue.some((o: { loanId: string }) => o.loanId === late.body.id)).toBe(true);
    expect(Number(dash.totals.outstanding)).toBeGreaterThan(0);
    expect(dash.statusCount.OVERDUE).toBe(1);

    const overdueOnly = (await app.get('/api/lending/loans?status=OVERDUE').set(H(token))).body;
    expect(overdueOnly.map((l: { id: string }) => l.id)).toEqual([late.body.id]);
    const byName = (await app.get('/api/lending/loans?q=maria').set(H(token))).body;
    expect(byName).toHaveLength(2);
    expect(byName[0].summary.progress).toBeGreaterThanOrEqual(0);
  });

  it('isolamento entre empresas', async () => {
    expect((await app.get(`/api/lending/loans/${loanId}`).set(H(tokenB))).status).toBe(404);
    expect((await app.get('/api/lending/loans').set(H(tokenB))).body).toHaveLength(0);
  });

  it('exclusão de empréstimo e de cliente', async () => {
    const blocked = await app.delete(`/api/clients/${clientId}`).set(H(token));
    expect(blocked.status).toBe(400);
    const loans = (await app.get('/api/lending/loans').set(H(token))).body as Array<{ id: string }>;
    for (const l of loans) expect((await app.delete(`/api/lending/loans/${l.id}`).set(H(token))).status).toBe(200);
    expect((await app.delete(`/api/clients/${clientId}`).set(H(token))).status).toBe(200);
  });
});

describe('contrato do empréstimo sobre saldo', () => {
  let app: ReturnType<typeof agent>;
  let token: string;
  beforeAll(async () => {
    await setupDb();
    await createCompanyWithAdmin('epsilon');
    app = agent(await makeApp());
    token = await login(app, 'admin@epsilon.local');
  });
  it('preenche o modelo, permite editar, gera PDF e guarda no histórico', async () => {
    await app.put('/api/lending/settings').set(H(token)).send({ creditor: { name: 'José Credor', cpf: '52998224725', nationality: 'brasileiro', maritalStatus: 'solteiro', profession: 'empresário', address: 'Rua A, 1', city: 'Campinas', state: 'SP', pixKey: '11999990000' }, lending: { lateFineRate: '2', lateInterestMonthly: '1' } });
    const c = await app.post('/api/clients').set(H(token)).send({ name: 'Maria Devedora', document: '111.444.777-35', maritalStatus: 'casada', profession: 'comerciante', addressStreet: 'Rua B', addressNumber: '2', addressCity: 'Campinas', addressState: 'SP' });
    const loan = await app.post('/api/lending/loans').set(H(token)).send({ clientId: c.body.id, amount: '1500', ratePct: '10', ratePeriod: 'MONTHLY', startDate: '2026-01-10', maturityDate: '2026-04-10', billingType: 'FIXED_INSTALLMENTS', disbursementMethod: 'PIX' });
    const draft = await app.post(`/api/lending/loans/${loan.body.id}/contract/draft`).set(H(token)).send({ witness1: 'Ana, CPF 000', guarantee: 'Nota promissória no valor total' });
    expect(draft.status).toBe(200);
    const t: string = draft.body.text;
    expect(t).toContain('CONTRATO DE EMPRÉSTIMO (MÚTUO) ENTRE PARTICULARES');
    expect(t).toContain('CREDOR: José Credor, brasileiro, solteiro, empresário, CPF 529.982.247-25, residente em Rua A, 1, Campinas/SP.');
    expect(t).toContain('R$ 1.500,00 (mil e quinhentos reais), entregue em 10/01/2026 por PIX');
    expect(t).toContain('juros de 10% ao mês');
    expect(t).toContain('3 parcela(s) mensais de R$ 603,17');
    expect(t).toContain('PIX para a chave 11999990000');
    expect(t).toContain('multa de 2% sobre o valor vencido e juros de mora de 1% ao mês');
    expect(t).toContain('Nota promissória no valor total');
    expect(t).toContain('foro da comarca de Campinas/SP');
    expect(draft.body.missing).toContain('Devedor (cadastro do cliente): nacionalidade');
    const saved = await app.post(`/api/lending/loans/${loan.body.id}/contracts`).set(H(token)).send({ text: t.replace('[preencher]', 'brasileira') });
    expect(saved.status).toBe(201);
    expect(saved.body.file.id).toBeTruthy();
    const pdf = await app.get(`/api/company/files/${saved.body.file.id}`).set(H(token));
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const detail = (await app.get(`/api/lending/loans/${loan.body.id}`).set(H(token))).body;
    expect(detail.contracts).toHaveLength(1);
    expect(detail.contracts[0].renderedContent).toContain('brasileira');
    expect((await app.post(`/api/lending/contracts/${saved.body.id}/signed`).set(H(token))).body.status).toBe('SIGNED');
  });

  it('exporta Excel/CSV e baixa backup', async () => {
    const x = await app.get('/api/lending/export.xlsx').set(H(token)).buffer(true);
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const csv = await app.get('/api/lending/export.csv?kind=loans').set(H(token));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Valor emprestado;');
    expect(csv.text).toContain('Maria Devedora');
    expect(csv.text).toContain('1500,00');
    const b = await app.get('/api/lending/backup.json').set(H(token));
    expect(b.status).toBe(200);
    const json = JSON.parse(b.text);
    expect(json.format).toBe('emprestimoshero-backup');
    expect(json.loans).toHaveLength(1);
    expect(json.company.settings.creditor.name).toBe('José Credor');
  });
});
