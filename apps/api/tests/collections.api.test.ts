import { describe, it, expect, beforeAll } from 'vitest';
import { setupDb, createCompanyWithAdmin, makeApp, login, agent } from './helpers.js';
import { hmacSign } from '../src/lib/crypto.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (days: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };
const H = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('cobranças automáticas e webhooks de pagamento', () => {
  let app: ReturnType<typeof agent>;
  let token: string;
  let clientId: string;
  let companyId: string;

  const activeLoan = async (firstDueOffset: number) => {
    const c = await app.post('/api/loans').set(H(token)).send({ clientId, requestedAmount: '600', installmentsCount: 2, disbursementDate: iso(plus(-30)), firstDueDate: iso(plus(firstDueOffset)), calcMethod: 'PRICE', monthlyRate: '3' });
    await app.post(`/api/loans/${c.body.id}/approve`).set(H(token)).send({});
    await app.post(`/api/loans/${c.body.id}/disburse`).set(H(token)).send({});
    return (await app.get(`/api/loans/${c.body.id}`).set(H(token))).body;
  };

  beforeAll(async () => {
    await setupDb();
    const { company } = await createCompanyWithAdmin('alfa');
    companyId = company.id;
    app = agent(await makeApp());
    token = await login(app, 'admin@alfa.local');
    const c = await app.post('/api/clients').set(H(token)).send({ name: 'Cliente Cobrança', document: '111.444.777-35', email: 'cob@x.local', phone: '11999990000' });
    clientId = c.body.id;
    // janela de envio ampla para o teste
    await app.put('/api/collections/settings').set(H(token)).send({ enabled: true, timezone: 'America/Sao_Paulo', sendHourStart: 0, sendHourEnd: 24, sendDays: [0, 1, 2, 3, 4, 5, 6], maxPerClientPerDay: 10, steps: [{ offsetDays: -3, channels: ['EMAIL', 'PORTAL'] }, { offsetDays: 0, channels: ['EMAIL', 'SMS'] }, { offsetDays: 3, channels: ['EMAIL'] }] });
  });

  it('agenda lembretes conforme a sequência, sem duplicar, e envia no horário', async () => {
    const loan = await activeLoan(0); // parcela 1 vence hoje
    const run1 = await app.post('/api/collections/run').set(H(token)).send({});
    expect(run1.status).toBe(200);
    const { prisma } = await import('../src/lib/prisma.js');
    const reminders = await prisma.reminder.findMany({ where: { installmentId: loan.installments[0].id } });
    // etapa "vence hoje" (EMAIL+SMS) e possivelmente "-3" não (fora da janela de agendamento) => 2 lembretes
    expect(reminders.filter((r) => r.offsetDays === 0)).toHaveLength(2);
    const today = reminders.filter((r) => r.offsetDays === 0);
    expect(today.every((r) => r.status === 'SENT')).toBe(true);
    expect(reminders.filter((r) => r.offsetDays === 3).every((r) => r.status === 'SCHEDULED' && r.scheduledFor > new Date())).toBe(true);
    expect(today[0].renderedBody).toContain('Cliente');
    expect(today[0].renderedBody).toContain('/portal/alfa/acesso?token=');
    const run2 = await app.post('/api/collections/run').set(H(token)).send({});
    expect(run2.body.scheduled.created).toBe(0);
    expect(await prisma.reminder.count({ where: { installmentId: loan.installments[0].id, offsetDays: 0 } })).toBe(2);
    const attempts = await prisma.reminderAttempt.count({ where: { reminder: { installmentId: loan.installments[0].id } } });
    expect(attempts).toBe(2);
  });

  it('cancela lembretes agendados após quitação e não envia com cobrança pausada', async () => {
    const loan = await activeLoan(3); // parcela 1 vence em 3 dias => etapa -3 agendada para hoje
    const { prisma } = await import('../src/lib/prisma.js');
    const { scheduleReminders } = await import('../src/modules/collections/collections.service.js');
    await scheduleReminders(companyId);
    const before = await prisma.reminder.findMany({ where: { installmentId: loan.installments[0].id } });
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.status === 'SCHEDULED')).toBe(true);
    // pausa: disparo é ignorado
    await app.post(`/api/loans/${loan.id}/collection/pause`).set(H(token)).send({ reason: 'Contestação' });
    const paused = await prisma.reminder.findMany({ where: { installmentId: loan.installments[0].id } });
    expect(paused.every((r) => r.status === 'CANCELLED')).toBe(true);
    await app.post(`/api/loans/${loan.id}/collection/resume`).set(H(token)).send({});
    // dedupe impede recriar as mesmas etapas já canceladas
    await scheduleReminders(companyId);
    // quitação cancela lembretes agendados
    const loan2 = await activeLoan(3);
    await scheduleReminders(companyId);
    const sched = await prisma.reminder.findMany({ where: { installmentId: loan2.installments[0].id, status: 'SCHEDULED' } });
    expect(sched.length).toBeGreaterThan(0);
    const pay = await app.post('/api/payments').set(H(token)).send({ installmentId: loan2.installments[0].id, amount: loan2.installments[0].balance.totalDue, method: 'PIX', paidAt: iso(new Date()) });
    expect(pay.status).toBe(201);
    const after = await prisma.reminder.findMany({ where: { installmentId: loan2.installments[0].id } });
    expect(after.every((r) => r.status === 'CANCELLED')).toBe(true);
    // disparo re-verifica a situação: lembrete agendado de parcela já paga é cancelado, não enviado
    const stale = await prisma.reminder.create({ data: { companyId, installmentId: loan2.installments[0].id, clientId, offsetDays: 3, channel: 'SMS', dedupeKey: `stale-${Date.now()}`, scheduledFor: new Date(Date.now() - 1000) } });
    const { dispatchReminders } = await import('../src/modules/collections/collections.service.js');
    await dispatchReminders(new Date(), companyId);
    expect((await prisma.reminder.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('CANCELLED');
  });

  it('respeita preferências de contato do cliente', async () => {
    await app.put(`/api/clients/${clientId}`).set(H(token)).send({ name: 'Cliente Cobrança', document: '11144477735', contactPreferences: { sms: false } });
    const loan = await activeLoan(0);
    const r = await app.post('/api/collections/send').set(H(token)).send({ installmentId: loan.installments[0].id, channel: 'SMS' });
    expect(r.body.outcome).toBe('SKIPPED');
    const e = await app.post('/api/collections/send').set(H(token)).send({ installmentId: loan.installments[0].id, channel: 'EMAIL' });
    expect(e.body.outcome).toBe('sent');
    await app.put(`/api/clients/${clientId}`).set(H(token)).send({ name: 'Cliente Cobrança', document: '11144477735', contactPreferences: { sms: true } });
  });

  it('webhook autenticado confirma pagamento uma única vez, mesmo reenviado', async () => {
    const loan = await activeLoan(5);
    const inst = loan.installments[0];
    const charge = await app.post('/api/payments/charges').set(H(token)).send({ installmentId: inst.id, type: 'PIX' });
    expect(charge.status).toBe(201);
    expect(charge.body.payload.copiaECola).toBeTruthy();
    // mesma cobrança pendente é reaproveitada
    expect((await app.post('/api/payments/charges').set(H(token)).send({ installmentId: inst.id, type: 'PIX' })).body.id).toBe(charge.body.id);
    const event = JSON.stringify({ id: 'evt-1', type: 'charge.paid', chargeId: charge.body.externalId, amount: charge.body.amount, paidAt: new Date().toISOString(), fee: '1.00', netAmount: (Number(charge.body.amount) - 1).toFixed(2) });
    // assinatura inválida
    expect((await app.post('/api/webhooks/payments/mock').set('Content-Type', 'application/json').set('x-signature', 'abc').send(event)).status).toBe(401);
    const sig = hmacSign('dev-webhook-secret', event);
    const first = await app.post('/api/webhooks/payments/mock').set('Content-Type', 'application/json').set('x-signature', sig).send(event);
    expect(first.body.status).toBe('PROCESSED');
    const again = await app.post('/api/webhooks/payments/mock').set('Content-Type', 'application/json').set('x-signature', sig).send(event);
    expect(again.body.status).toBe('DUPLICATE');
    const d = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    expect(d.installments[0].status).toBe('PAID');
    expect(d.payments.filter((p: { status: string }) => p.status === 'CONFIRMED')).toHaveLength(1);
    expect(d.payments[0].source).toBe('PROVIDER');
    const rec = await app.get('/api/payments/charges/reconciliation').set(H(token));
    expect(rec.body.totals.paid.count).toBe(1);
    expect(rec.body.totals.paid.fees).toBe('1.00');
    // evento com outro id para cobrança já paga é ignorado sem duplicar pagamento
    const ev2 = JSON.stringify({ id: 'evt-2', type: 'charge.paid', chargeId: charge.body.externalId, amount: charge.body.amount });
    const r2 = await app.post('/api/webhooks/payments/mock').set('Content-Type', 'application/json').set('x-signature', hmacSign('dev-webhook-secret', ev2)).send(ev2);
    expect(r2.body.status).toBe('IGNORED');
    expect((await app.get(`/api/loans/${loan.id}`).set(H(token))).body.payments.filter((p: { status: string }) => p.status === 'CONFIRMED')).toHaveLength(1);
  });

  it('comprovante enviado fica pendente até conferência', async () => {
    const loan = await activeLoan(10);
    const inst = loan.installments[0];
    const { registerPayment } = await import('../src/modules/payments/payments.service.js');
    const { systemContext } = await import('../src/lib/system.js');
    const p = await registerPayment(systemContext(companyId, 'Portal'), { installmentId: inst.id, amount: '100', discount: '0', method: 'PIX', paidAt: iso(new Date()), source: 'CLIENT_UPLOAD' }, { status: 'PENDING_REVIEW', receivedByName: 'Cliente' });
    expect(p.status).toBe('PENDING_REVIEW');
    let d = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    expect(d.installments[0].status).toBe('PENDING');
    expect(Number(d.summary.totalPaid)).toBe(0);
    const ok = await app.post(`/api/payments/${p.id}/review`).set(H(token)).send({ decision: 'approve' });
    expect(ok.body.status).toBe('CONFIRMED');
    d = (await app.get(`/api/loans/${loan.id}`).set(H(token))).body;
    expect(d.installments[0].status).toBe('PARTIAL');
    expect(Number(d.summary.totalPaid)).toBe(100);
  });
});
