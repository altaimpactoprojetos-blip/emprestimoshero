import { describe, it, expect, beforeAll } from 'vitest';
import { setupDb, createCompanyWithAdmin, makeApp, login, agent } from './helpers.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (days: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };

describe('clientes e empréstimos (API) com isolamento entre empresas', () => {
  let app: ReturnType<typeof agent>;
  let tokenA: string, tokenB: string;
  let clientA: string;

  beforeAll(async () => {
    await setupDb();
    await createCompanyWithAdmin('alfa');
    await createCompanyWithAdmin('beta');
    app = agent(await makeApp());
    tokenA = await login(app, 'admin@alfa.local');
    tokenB = await login(app, 'admin@beta.local');
  });

  it('cadastra cliente, valida CPF e impede duplicidade na mesma empresa', async () => {
    const bad = await app.post('/api/clients').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Fulano de Tal', document: '123.456.789-00' });
    expect(bad.status).toBe(400);
    const ok = await app.post('/api/clients').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Fulano de Tal', document: '111.444.777-35', email: 'fulano@x.local', phone: '(11) 98888-7777' });
    expect(ok.status).toBe(201);
    clientA = ok.body.id;
    const dup = await app.post('/api/clients').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Outro', document: '11144477735' });
    expect(dup.status).toBe(409);
    // mesma pessoa pode existir em outra empresa
    const other = await app.post('/api/clients').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Fulano na Beta', document: '11144477735' });
    expect(other.status).toBe(201);
  });

  it('empresa B não enxerga cliente da empresa A', async () => {
    const r = await app.get(`/api/clients/${clientA}`).set('Authorization', `Bearer ${tokenB}`);
    expect(r.status).toBe(404);
    const list = await app.get('/api/clients').set('Authorization', `Bearer ${tokenB}`);
    expect(list.body.some((c: { id: string }) => c.id === clientA)).toBe(false);
  });

  it('simula, cadastra, aprova e libera empréstimo com valores idênticos', async () => {
    const input = { clientId: clientA, requestedAmount: '1000', installmentsCount: 3, disbursementDate: iso(new Date()), firstDueDate: iso(plus(30)), calcMethod: 'PRICE', monthlyRate: '5', originationFee: '10' };
    const sim = await app.post('/api/loans/simulate').set('Authorization', `Bearer ${tokenA}`).send(input);
    expect(sim.status).toBe(200);
    expect(sim.body.installmentAmount).toBe('367.21');
    expect(sim.body.disbursedAmount).toBe('990.00');
    const created = await app.post('/api/loans').set('Authorization', `Bearer ${tokenA}`).send(input);
    expect(created.status).toBe(201);
    expect(created.body.installmentAmount).toBe('367.21');
    const id = created.body.id;
    // empresa B não acessa nem transiciona
    expect((await app.get(`/api/loans/${id}`).set('Authorization', `Bearer ${tokenB}`)).status).toBe(404);
    expect((await app.post(`/api/loans/${id}/approve`).set('Authorization', `Bearer ${tokenB}`).send({})).status).toBe(404);
    // liberar antes de aprovar é bloqueado
    expect((await app.post(`/api/loans/${id}/disburse`).set('Authorization', `Bearer ${tokenA}`).send({})).status).toBe(400);
    expect((await app.post(`/api/loans/${id}/submit`).set('Authorization', `Bearer ${tokenA}`).send({})).status).toBe(200);
    expect((await app.post(`/api/loans/${id}/approve`).set('Authorization', `Bearer ${tokenA}`).send({ notes: 'ok' })).status).toBe(200);
    const dis = await app.post(`/api/loans/${id}/disburse`).set('Authorization', `Bearer ${tokenA}`).send({});
    expect(dis.status).toBe(200);
    expect(dis.body.status).toBe('ACTIVE');
    const detail = await app.get(`/api/loans/${id}`).set('Authorization', `Bearer ${tokenA}`);
    expect(detail.body.installments).toHaveLength(3);
    expect(detail.body.installments.map((i: { originalAmount: string }) => i.originalAmount)).toEqual(sim.body.schedule.map((r: { amount: string }) => r.amount));
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'SUBMITTED', 'APPROVED', 'DISBURSED']);
  });

  it('usuário sem permissão de aprovação recebe 403', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const bcrypt = (await import('bcryptjs')).default;
    const company = await prisma.company.findUniqueOrThrow({ where: { slug: 'alfa' } });
    await prisma.user.create({ data: { companyId: company.id, name: 'Cobrador', email: 'cob@alfa.local', passwordHash: await bcrypt.hash('Senha@123', 4), role: 'COLLECTION' } });
    const t = await login(app, 'cob@alfa.local');
    const loan = await prisma.loan.findFirstOrThrow({ where: { companyId: company.id } });
    expect((await app.post(`/api/loans/${loan.id}/approve`).set('Authorization', `Bearer ${t}`).send({})).status).toBe(403);
    expect((await app.get('/api/loans').set('Authorization', `Bearer ${t}`)).status).toBe(200);
  });
});
