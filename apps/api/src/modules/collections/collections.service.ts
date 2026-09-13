import { addDays, addMinutes } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { Channel } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { computeBalance } from '../../domain/installment.js';
import { dateOnly, formatBRDate, todayIn, zonedDateTime } from '../../lib/dates.js';
import { formatBRL } from '../../lib/money.js';
import { sendMail } from '../../services/mailer.js';
import { sendSms } from '../../services/sms.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { config } from '../../config.js';
import { firstName } from '../../lib/text.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

export interface Step { offsetDays: number; channels: Channel[] }

export const DEFAULT_MESSAGES: Array<{ key: string; channel: Channel; subject?: string; body: string }> = [
  { key: 'BEFORE_DUE', channel: 'EMAIL', subject: '{{empresa}}: lembrete de vencimento da parcela {{parcela}}', body: 'Olá, {{nome}}.\n\nA parcela {{parcela}} do seu contrato nº {{contrato}} vence em {{vencimento}}, no valor de {{valor}}.\n\nPara consultar e pagar, acesse: {{link}}\n\nSe já efetuou o pagamento, desconsidere esta mensagem.\n\n{{empresa}}' },
  { key: 'BEFORE_DUE', channel: 'SMS', body: '{{empresa}}: {{nome}}, a parcela {{parcela}} vence em {{vencimento}} ({{valor}}). Consulte: {{link}}' },
  { key: 'BEFORE_DUE', channel: 'PORTAL', subject: 'Parcela {{parcela}} vence em {{vencimento}}', body: 'Sua parcela {{parcela}} do contrato nº {{contrato}} vence em {{vencimento}}, no valor de {{valor}}.' },
  { key: 'DUE_TODAY', channel: 'EMAIL', subject: '{{empresa}}: sua parcela {{parcela}} vence hoje', body: 'Olá, {{nome}}.\n\nA parcela {{parcela}} do seu contrato nº {{contrato}} vence hoje ({{vencimento}}), no valor de {{valor}}.\n\nAcesse para consultar os meios de pagamento: {{link}}\n\nSe já efetuou o pagamento, desconsidere esta mensagem.\n\n{{empresa}}' },
  { key: 'DUE_TODAY', channel: 'SMS', body: '{{empresa}}: {{nome}}, a parcela {{parcela}} vence hoje ({{valor}}). Pague em: {{link}}' },
  { key: 'DUE_TODAY', channel: 'PORTAL', subject: 'Parcela {{parcela}} vence hoje', body: 'Sua parcela {{parcela}} do contrato nº {{contrato}} vence hoje, no valor de {{valor}}.' },
  { key: 'OVERDUE', channel: 'EMAIL', subject: '{{empresa}}: parcela {{parcela}} em aberto', body: 'Olá, {{nome}}.\n\nIdentificamos que a parcela {{parcela}} do seu contrato nº {{contrato}}, vencida em {{vencimento}}, está em aberto. O saldo atualizado é de {{saldo}} ({{dias_atraso}} dia(s) de atraso).\n\nPara regularizar ou falar conosco, acesse: {{link}}\n\nSe já efetuou o pagamento, desconsidere esta mensagem.\n\n{{empresa}}' },
  { key: 'OVERDUE', channel: 'SMS', body: '{{empresa}}: {{nome}}, a parcela {{parcela}} venceu em {{vencimento}}. Saldo atualizado {{saldo}}. Regularize em: {{link}}' },
  { key: 'OVERDUE', channel: 'PORTAL', subject: 'Parcela {{parcela}} em aberto', body: 'A parcela {{parcela}} do contrato nº {{contrato}}, vencida em {{vencimento}}, está em aberto. Saldo atualizado: {{saldo}}.' },
];

export async function ensureDefaults(companyId: string) {
  const settings = await prisma.collectionSettings.upsert({ where: { companyId }, create: { companyId }, update: {} });
  const existing = await prisma.messageTemplate.findMany({ where: { companyId } });
  const missing = DEFAULT_MESSAGES.filter((m) => !existing.some((e) => e.key === m.key && e.channel === m.channel));
  if (missing.length) await prisma.messageTemplate.createMany({ data: missing.map((m) => ({ ...m, companyId })) });
  return settings;
}

const keyForOffset = (offset: number) => (offset < 0 ? 'BEFORE_DUE' : offset === 0 ? 'DUE_TODAY' : 'OVERDUE');

/** Gera link seguro de acesso ao portal (token de uso único, 7 dias). */
export async function createSecureLink(companyId: string, clientId: string, target: string) {
  const raw = randomToken(24);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { slug: true } });
  await prisma.clientAccessToken.create({ data: { companyId, clientId, tokenHash: sha256(raw), target, expiresAt: addDays(new Date(), 7) } });
  return `${config.appUrl}/portal/${company.slug}/acesso?token=${raw}`;
}

export function render(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * Agenda lembretes para parcelas em aberto de acordo com a sequência configurada.
 * Idempotente pela chave installmentId:offset:channel. Só agenda etapas cuja data alvo esteja entre
 * ontem e os próximos 3 dias, evitando disparos retroativos ao ativar a automação.
 */
export async function scheduleReminders(companyId: string, now = new Date()) {
  const settings = await ensureDefaults(companyId);
  if (!settings.enabled) return { created: 0 };
  const steps = settings.steps as unknown as Step[];
  const today = todayIn(settings.timezone, now);
  const installments = await prisma.installment.findMany({ where: { companyId, status: { in: ['PENDING', 'PARTIAL'] }, loan: { status: 'ACTIVE', collectionState: 'ACTIVE' } }, include: { loan: { select: { clientId: true } } } });
  let created = 0;
  for (const inst of installments) {
    for (const step of steps) {
      const target = dateOnly(addDays(inst.dueDate, step.offsetDays));
      const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
      if (diff < -1 || diff > 3) continue;
      for (const channel of step.channels) {
        const r = await prisma.reminder.createMany({ data: [{ companyId, installmentId: inst.id, clientId: inst.loan.clientId, offsetDays: step.offsetDays, channel, dedupeKey: `${inst.id}:${step.offsetDays}:${channel}`, scheduledFor: zonedDateTime(target, settings.sendHourStart, 0, settings.timezone) }], skipDuplicates: true });
        created += r.count;
      }
    }
  }
  return { created };
}

async function sendReminderNow(reminderId: string, now: Date, opts: { ignoreWindow?: boolean } = {}): Promise<string> {
  const r = await prisma.reminder.findUnique({ where: { id: reminderId }, include: { installment: { include: { loan: { include: { client: true, company: true } } } } } });
  if (!r || r.status !== 'SCHEDULED') return 'skip';
  const inst = r.installment;
  const loan = inst.loan;
  const client = loan.client;
  const company = loan.company;
  const settings = await ensureDefaults(r.companyId);
  const fail = async (status: 'CANCELLED' | 'SKIPPED', reason: string) => { await prisma.reminder.update({ where: { id: r.id }, data: { status, cancelReason: reason } }); return status; };
  // situação reavaliada antes de cada envio
  if (!['PENDING', 'PARTIAL'].includes(inst.status)) return fail('CANCELLED', 'Parcela quitada ou renegociada');
  if (loan.status !== 'ACTIVE') return fail('CANCELLED', 'Empréstimo não está em andamento');
  if (loan.collectionState === 'PAUSED') return fail('SKIPPED', `Cobrança pausada: ${loan.collectionPauseReason ?? ''}`);
  const prefs = (client.contactPreferences ?? {}) as Record<string, boolean>;
  if (r.channel === 'EMAIL' && (prefs.email === false || !client.email)) return fail('SKIPPED', 'Cliente sem e-mail ou sem consentimento para e-mail');
  if (r.channel === 'SMS' && (prefs.sms === false || !client.phone)) return fail('SKIPPED', 'Cliente sem telefone ou sem consentimento para SMS');
  if (r.channel === 'PORTAL' && prefs.portal === false) return fail('SKIPPED', 'Cliente optou por não receber avisos no portal');
  if (!r.manual && !opts.ignoreWindow) {
    const z = toZonedTime(now, settings.timezone);
    const hour = z.getHours();
    const day = z.getDay();
    if (!settings.sendDays.includes(day) || hour < settings.sendHourStart || hour >= settings.sendHourEnd) {
      // fora da janela: reagenda para a próxima abertura da janela
      let next = dateOnly(new Date(Date.UTC(z.getFullYear(), z.getMonth(), z.getDate())));
      if (hour >= settings.sendHourEnd || !settings.sendDays.includes(day)) next = dateOnly(addDays(next, 1));
      for (let i = 0; i < 8 && !settings.sendDays.includes(toZonedTime(zonedDateTime(next, settings.sendHourStart, 0, settings.timezone), settings.timezone).getDay()); i++) next = dateOnly(addDays(next, 1));
      await prisma.reminder.update({ where: { id: r.id }, data: { scheduledFor: zonedDateTime(next, settings.sendHourStart, 0, settings.timezone) } });
      return 'deferred';
    }
    // limite de frequência por cliente (considera todos os contratos)
    const dayStart = zonedDateTime(todayIn(settings.timezone, now), 0, 0, settings.timezone);
    const sentToday = await prisma.reminder.count({ where: { clientId: client.id, status: 'SENT', sentAt: { gte: dayStart }, channel: { in: ['EMAIL', 'SMS'] } } });
    if (r.channel !== 'PORTAL' && sentToday >= settings.maxPerClientPerDay) {
      await prisma.reminder.update({ where: { id: r.id }, data: { scheduledFor: zonedDateTime(dateOnly(addDays(todayIn(settings.timezone, now), 1)), settings.sendHourStart, 0, settings.timezone) } });
      return 'deferred';
    }
  }
  const today = todayIn(settings.timezone, now);
  const balance = computeBalance(inst, loan, today);
  const tpl = await prisma.messageTemplate.findUnique({ where: { companyId_key_channel: { companyId: r.companyId, key: keyForOffset(r.offsetDays), channel: r.channel } } });
  if (!tpl) return fail('SKIPPED', 'Modelo de mensagem não configurado');
  const link = await createSecureLink(r.companyId, client.id, `/parcelas`);
  const vars = { nome: firstName(client.name), nome_completo: client.name, empresa: company.name, parcela: `${inst.number}/${loan.installmentsCount}`, contrato: String(loan.number), vencimento: formatBRDate(inst.dueDate), valor: formatBRL(inst.originalAmount), saldo: formatBRL(balance.totalDue), dias_atraso: String(balance.daysLate), link };
  const subject = tpl.subject ? render(tpl.subject, vars) : undefined;
  const body = render(tpl.body, vars);
  let ok = false, providerId: string | undefined, error: string | undefined;
  try {
    if (r.channel === 'EMAIL') { const res = await sendMail({ to: client.email!, subject: subject ?? 'Lembrete', text: body }); ok = res.ok; providerId = res.providerId; error = res.error; }
    else if (r.channel === 'SMS') { const res = await sendSms(client.phone!, body); ok = res.ok; providerId = res.providerId; error = res.error; }
    else { const n = await prisma.notification.create({ data: { companyId: r.companyId, clientId: client.id, title: subject ?? 'Aviso de cobrança', body, link: '/parcelas' } }); ok = true; providerId = n.id; }
  } catch (e) { error = (e as Error).message; }
  const attempts = r.attempts + 1;
  await prisma.reminderAttempt.create({ data: { reminderId: r.id, number: attempts, status: ok ? 'SENT' : 'FAILED', response: ok ? providerId ?? null : error ?? null } });
  if (ok) {
    await prisma.reminder.update({ where: { id: r.id }, data: { status: 'SENT', sentAt: now, attempts, providerMessageId: providerId ?? null, renderedSubject: subject ?? null, renderedBody: body, lastError: null } });
    return 'sent';
  }
  const giveUp = attempts >= 3;
  await prisma.reminder.update({ where: { id: r.id }, data: { status: giveUp ? 'FAILED' : 'SCHEDULED', attempts, lastError: error ?? 'Falha desconhecida', renderedSubject: subject ?? null, renderedBody: body, scheduledFor: giveUp ? r.scheduledFor : addMinutes(now, 30) } });
  if (giveUp) await prisma.integrationIssue.create({ data: { companyId: r.companyId, kind: r.channel === 'EMAIL' ? 'EMAIL' : 'SMS', reference: r.id, message: `Falha ao enviar lembrete (${r.channel}) para ${client.name}: ${error}` } });
  return 'failed';
}

/** Processa lembretes agendados cujo horário chegou. Executado pelo worker (independente do navegador). */
export async function dispatchReminders(now = new Date(), companyId?: string) {
  const due = await prisma.reminder.findMany({ where: { status: 'SCHEDULED', scheduledFor: { lte: now }, ...(companyId ? { companyId } : {}) }, orderBy: { scheduledFor: 'asc' }, take: 500 });
  const result: Record<string, number> = {};
  for (const r of due) {
    const outcome = await sendReminderNow(r.id, now);
    result[outcome] = (result[outcome] ?? 0) + 1;
  }
  return result;
}

export async function sendManualReminder(ctx: AuthContext, installmentId: string, channel: Channel) {
  const inst = await prisma.installment.findFirst({ where: { id: installmentId, companyId: ctx.companyId! }, include: { loan: true } });
  if (!inst) throw notFound('Parcela não encontrada');
  if (!['PENDING', 'PARTIAL'].includes(inst.status)) throw badRequest('Parcela não está em aberto');
  const today = todayIn((await prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId! } })).timezone);
  const offset = Math.round((today.getTime() - dateOnly(inst.dueDate).getTime()) / 86400000);
  const r = await prisma.reminder.create({ data: { companyId: ctx.companyId!, installmentId, clientId: inst.loan.clientId, offsetDays: offset, channel, dedupeKey: `${installmentId}:manual:${channel}:${Date.now()}`, scheduledFor: new Date(), manual: true } });
  const outcome = await sendReminderNow(r.id, new Date(), { ignoreWindow: true });
  await audit(ctx, { action: 'REMINDER_MANUAL_SEND', entity: 'Reminder', entityId: r.id, after: { installmentId, channel, outcome } });
  return { reminder: await prisma.reminder.findUniqueOrThrow({ where: { id: r.id } }), outcome };
}

/** Executa agendamento + disparo para uma empresa (acionado manualmente pela central ou pelo worker). */
export async function runCollectionsFor(companyId: string, now = new Date()) {
  const scheduled = await scheduleReminders(companyId, now);
  const dispatched = await dispatchReminders(now, companyId);
  return { scheduled, dispatched };
}

export async function runCollectionsAll(now = new Date()) {
  const companies = await prisma.company.findMany({ where: { status: { in: ['ACTIVE', 'TRIAL'] } }, select: { id: true, name: true } });
  const out: Record<string, unknown> = {};
  for (const c of companies) {
    try { out[c.name] = await runCollectionsFor(c.id, now); } catch (e) { out[c.name] = { error: (e as Error).message }; console.error(`[cobranças] ${c.name}:`, e); }
  }
  return out;
}
