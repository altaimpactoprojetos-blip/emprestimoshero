import { describe, it, expect, beforeAll } from 'vitest';
import { setupDb, createCompanyWithAdmin, makeApp, login, agent } from './helpers.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (days: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };
const H = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('relatórios, fechamento mensal e portal do cliente', () => {
  let app: ReturnType<typeof agent>;
  let token: string;
  let clientId: string;
  let otherClientId: string;
  let loanId: string;

  beforeAll(async () => {
    await setupDb();
    await createCompanyWithAdmin('alfa');
    app = agent(await makeApp());
    token = await login(app, 'admin@alfa.local');
    clientId = (await app.post('/api/clients').set(H(token)).send({ name: 'Cliente Portal', document: '111.444.777-35', email: 'portal@x.local', phone: '11999990000' })).body.id;
    otherClientId = (await app.post('/api/clients').set(H(token)).send({ name: 'Outro Cliente', document: '529.982.247-25' })).body.id;
    for (const cid of [clientId, otherClientId]) {
      const c = await app.post('/api/loans').set(H(token)).send({ clientId: cid, requestedAmount: '1000', installmentsCount: 3, disbursementDate: iso(plus(-40)), firstDueDate: iso(plus(-10)), calcMethod: 'PRICE', monthlyRate: '5' });
      await app.post(`/api/loans/${c.body.id}/approve`).set(H(token)).send({});
      await app.post(`/api/loans/${c.body.id}/disburse`).set(H(token)).send({ date: iso(plus(-40)) });
      if (cid === clientId) loanId = c.body.id;
    }
    const loan = (await app.get(`/api/loans/${loanId}`).set(H(token))).body;
    await app.post('/api/payments').set(H(token)).send({ installmentId: loan.installments[0].id, amount: '300', method: 'PIX', paidAt: iso(new Date()) });
    await app.post(`/api/clients/${clientId}/portal-access`).set(H(token)).send({ password: 'Senha@123' });
  });

  it('dashboard separa recebido de previsto e mostra fórmulas', async () => {
    const d = await app.get(`/api/reports/dashboard?from=${iso(plus(-60))}&to=${iso(new Date())}`).set(H(token));
    expect(d.status).toBe(200);
    expect(Number(d.body.disbursed.amount)).toBeCloseTo(2000, 0);
    expect(Number(d.body.received.total)).toBe(300);
    expect(Number(d.body.received.principal) + Number(d.body.received.interest) + Number(d.body.received.charges)).toBeCloseTo(300, 2);
    expect(Number(d.body.expected.amount)).toBeGreaterThan(0);
    expect(d.body.overdue.count).toBe(2);
    expect(d.body.overdue.clients).toBe(2);
    expect(d.body.formulas.overdueRate).toContain('÷');
    expect(Number(d.body.indicators.overdueRate)).toBeGreaterThan(0);
  });

  it('fecha o mês com versão e data de referência, exporta PDF e Excel', async () => {
    const month = iso(new Date()).slice(0, 7);
    const preview = await app.get(`/api/reports/monthly/preview?month=${month}`).set(H(token));
    expect(preview.status).toBe(200);
    expect(Number(preview.body.totals.receivedTotal)).toBe(300);
    expect(preview.body.details.payments).toHaveLength(1);
    const c1 = await app.post('/api/reports/monthly/close').set(H(token)).send({ month });
    expect(c1.status).toBe(201);
    expect(c1.body.version).toBe(1);
    const c2 = await app.post('/api/reports/monthly/close').set(H(token)).send({ month });
    expect(c2.body.version).toBe(2);
    const detail = await app.get(`/api/reports/monthly/${c2.body.id}`).set(H(token));
    expect(detail.body.previous).toBeDefined();
    const pdf = await app.get(`/api/reports/monthly/${c2.body.id}/pdf`).set(H(token));
    expect(pdf.headers['content-type']).toContain('pdf');
    const xlsx = await app.get(`/api/reports/monthly/${c2.body.id}/xlsx`).set(H(token));
    expect(xlsx.headers['content-type']).toContain('spreadsheet');
    const ext = await app.get(`/api/reports/receipts?from=${iso(plus(-5))}&to=${iso(new Date())}&clientId=${clientId}&format=xlsx`).set(H(token));
    expect(ext.status).toBe(200);
    const { closePreviousMonthForAll } = await import('../src/modules/reports/reports.service.js');
    const auto = await closePreviousMonthForAll();
    expect(auto['Empresa alfa']).toContain('fechado');
  });

  it('portal: cliente vê apenas seus contratos, baixa recibo, envia comprovante e abre solicitação', async () => {
    const login = await app.post('/api/auth/portal/login').send({ companySlug: 'alfa', identifier: '111.444.777-35', password: 'Senha@123' });
    expect(login.status).toBe(200);
    const t = login.body.accessToken as string;
    const me = await app.get('/api/portal/me').set(H(t));
    expect(me.status).toBe(200);
    expect(me.body.loans).toHaveLength(1);
    expect(me.body.loans[0].id).toBe(loanId);
    expect(me.body.client.name).toBe('Cliente Portal');
    // rotas da equipe são negadas ao cliente
    expect((await app.get('/api/clients').set(H(t))).status).toBe(403);
    expect((await app.get(`/api/loans/${loanId}`).set(H(t))).status).toBe(403);
    const pays = await app.get('/api/portal/payments').set(H(t));
    expect(pays.body).toHaveLength(1);
    expect((await app.get(`/api/portal/payments/${pays.body[0].id}/receipt`).set(H(t))).status).toBe(200);
    // comprovante de parcela de outro cliente é negado
    const otherLoan = (await app.get(`/api/loans?clientId=${otherClientId}`).set(H(token))).body[0];
    const otherInst = (await app.get(`/api/loans/${otherLoan.id}`).set(H(token))).body.installments[0];
    const denied = await app.post('/api/portal/proofs').set(H(t)).field('installmentId', otherInst.id).field('amount', '10').field('paidAt', iso(new Date())).attach('file', Buffer.from('x'), 'c.png');
    expect(denied.status).toBe(404);
    const inst = me.body.loans[0].installments[1];
    const proof = await app.post('/api/portal/proofs').set(H(t)).field('installmentId', inst.id).field('amount', '50').field('paidAt', iso(new Date())).attach('file', Buffer.from('comprovante'), 'comprovante.png');
    expect(proof.status).toBe(201);
    expect(proof.body.status).toBe('PENDING_REVIEW');
    const charge = await app.post('/api/portal/charges').set(H(t)).send({ installmentId: inst.id, type: 'PIX' });
    expect(charge.status).toBe(201);
    const sr = await app.post('/api/portal/requests').set(H(t)).send({ type: 'DISPUTE', message: 'Não reconheço esta parcela', loanId });
    expect(sr.status).toBe(201);
    expect((await app.get(`/api/loans/${loanId}`).set(H(token))).body.collectionState).toBe('PAUSED');
    const pref = await app.put('/api/portal/preferences').set(H(t)).send({ contactPreferences: { sms: false } });
    expect(pref.body.contactPreferences.sms).toBe(false);
    // link seguro
    const { createSecureLink } = await import('../src/modules/collections/collections.service.js');
    const { prisma } = await import('../src/lib/prisma.js');
    const company = await prisma.company.findUniqueOrThrow({ where: { slug: 'alfa' } });
    const link = await createSecureLink(company.id, clientId, '/parcelas');
    const tokenParam = new URL(link).searchParams.get('token')!;
    const viaLink = await app.post('/api/auth/portal/token').send({ token: tokenParam });
    expect(viaLink.status).toBe(200);
    expect(viaLink.body.user.role).toBe('CLIENT');
    expect((await app.post('/api/auth/portal/token').send({ token: tokenParam })).status).toBe(200); // reutilizável até expirar, mas registra uso
    expect((await app.post('/api/auth/portal/token').send({ token: 'invalido-invalido' })).status).toBe(401);
  });
});
