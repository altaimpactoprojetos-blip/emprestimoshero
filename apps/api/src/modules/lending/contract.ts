/**
 * Contrato de mútuo entre particulares para empréstimos sobre saldo devedor.
 * O texto é montado a partir do modelo com os dados já cadastrados, pode ser editado antes de
 * gerar e fica guardado (texto + PDF + hash) no histórico do empréstimo.
 */
import { z } from 'zod';
import type { Client } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { zDate } from '../../lib/validate.js';
import { D, cents, type Dec } from '../../lib/money.js';
import { dateOnly, formatBRDate, todayIn } from '../../lib/dates.js';
import { maskDoc } from '../../lib/text.js';
import { valorPorExtenso } from '../../lib/extenso.js';
import { renderPdf, type Block } from '../../services/pdf.js';
import { storeFile } from '../../lib/storage.js';
import { sha256 } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import type { AuthContext } from '../../middleware/auth.js';
import { addEvent } from '../loans/loans.service.js';
import { simulateBalance } from '../../domain/balance.js';
import { readSettings, termsOf, type CreditorSettings } from './lending.service.js';

export const contractOptionsSchema = z.object({
  disbursementMethod: z.string().max(80),
  paymentMethod: z.string().max(200),
  guarantee: z.string().max(1000),
  witness1: z.string().max(200),
  witness2: z.string().max(200),
  accelerationDays: z.number().int().min(0).max(3650),
  quitationDays: z.number().int().min(0).max(365),
  forum: z.string().max(120),
  city: z.string().max(120),
  date: zDate,
}).partial();
export type ContractOptions = z.infer<typeof contractOptionsSchema>;

const FILL = '[preencher]';
const brlPlain = (v: Dec | string | number) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(D(v).toNumber());
const brl = (v: Dec | string | number) => `R$ ${brlPlain(v)}`;
const pctText = (v: Dec | string | number) => D(v).toDecimalPlaces(4).toString().replace('.', ',');
const RATE_PERIOD_TEXT: Record<string, string> = { DAILY: 'ao dia', WEEKLY: 'por semana', BIWEEKLY: 'por quinzena', MONTHLY: 'ao mês' };
const PERIOD_ADJ: Record<string, string> = { DAILY: 'diárias', WEEKLY: 'semanais', BIWEEKLY: 'quinzenais', MONTHLY: 'mensais' };
const PERIOD_EACH: Record<string, string> = { DAILY: 'a cada dia', WEEKLY: 'a cada semana', BIWEEKLY: 'a cada quinzena', MONTHLY: 'a cada mês' };

function clientAddress(c: Client) {
  return [c.addressStreet, c.addressNumber, c.addressComplement, c.addressDistrict, c.addressCity && `${c.addressCity}${c.addressState ? `/${c.addressState}` : ''}`, c.addressZip && `CEP ${c.addressZip}`].filter(Boolean).join(', ');
}

function qualification(p: { name?: string | null; nationality?: string | null; maritalStatus?: string | null; profession?: string | null; cpf?: string | null; address?: string | null }, missing: string[], who: string) {
  const v = (x: string | null | undefined, label: string) => { if (x && x.trim()) return x.trim(); missing.push(`${who}: ${label}`); return FILL; };
  return `${v(p.name, 'nome')}, ${v(p.nationality, 'nacionalidade')}, ${v(p.maritalStatus, 'estado civil')}, ${v(p.profession, 'profissão')}, CPF ${p.cpf ? maskDoc(p.cpf) : v(null, 'CPF')}, residente em ${v(p.address, 'endereço')}`;
}

const dateList = (dates: Date[]) => {
  const t = dates.map((d) => formatBRDate(d));
  return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} e ${t.at(-1)}`;
};

/** Monta a Cláusula 3 conforme o tipo de cobrança. */
function paymentClause(loan: Parameters<typeof termsOf>[0]): string {
  const terms = termsOf(loan);
  const sim = simulateBalance(terms);
  const rows = sim.periods;
  const n = rows.length;
  const period = loan.periodicity;
  const listOrRange = (r: typeof rows) => (r.length <= 12 ? `com vencimentos em ${dateList(r.map((x) => x.dueDate))}` : `${PERIOD_EACH[period]}, de ${formatBRDate(r[0].dueDate)} a ${formatBRDate(r.at(-1)!.dueDate)}`);
  if (loan.billingType === 'SINGLE_PAYMENT') {
    const total = rows.at(-1)!.amountDue;
    return `um pagamento único de ${brl(total)} (${valorPorExtenso(total)}), correspondente ao principal mais os juros do período, com vencimento em ${formatBRDate(rows.at(-1)!.dueDate)}`;
  }
  if (loan.billingType === 'INTEREST_ONLY') {
    const interestRows = rows.slice(0, -1);
    const last = rows.at(-1)!;
    const interest = rows[0].interest;
    const head = interestRows.length
      ? `${interestRows.length} pagamento(s) ${PERIOD_ADJ[period]} somente de juros, de ${brl(interest)} (${valorPorExtenso(interest)}) cada, ${listOrRange(interestRows)}, e `
      : '';
    return `${head}um pagamento final de ${brl(last.amountDue)} (${valorPorExtenso(last.amountDue)}), correspondente ao principal de ${brl(last.principalDue)} mais os juros do último período, em ${formatBRDate(last.dueDate)}`;
  }
  const first = rows[0].amountDue;
  const lastAmt = rows.at(-1)!.amountDue;
  const diff = !cents(first).eq(cents(lastAmt));
  return `${n} parcela(s) ${PERIOD_ADJ[period]} de ${brl(first)} (${valorPorExtenso(first)})${diff ? `, sendo a última de ${brl(lastAmt)}` : ''}, ${listOrRange(rows)}`;
}

export async function contractDraft(companyId: string, loanId: string, opts: ContractOptions = {}) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, companyId }, include: { client: true, company: true } });
  if (!loan) throw notFound('Empréstimo não encontrado');
  if (loan.engine !== 'BALANCE') throw badRequest('Use a tela de contratos para empréstimos com parcelas pré-calculadas');
  const { creditor, lending } = readSettings(loan.company.settings);
  const missing: string[] = [];
  const cr: CreditorSettings = creditor;
  const creditorAddress = cr.address ? `${cr.address}${cr.city ? `, ${cr.city}${cr.state ? `/${cr.state}` : ''}` : ''}` : '';
  const credor = qualification({ name: cr.name, nationality: cr.nationality, maritalStatus: cr.maritalStatus, profession: cr.profession, cpf: cr.cpf, address: creditorAddress }, missing, 'Credor (Configurações)');
  const c = loan.client;
  const devedor = qualification({ name: c.name, nationality: c.nationality, maritalStatus: c.maritalStatus, profession: c.profession, cpf: c.document, address: clientAddress(c) }, missing, 'Devedor (cadastro do cliente)');
  const today = todayIn(loan.company.timezone);
  const city = opts.city || cr.city || '';
  const cityUF = city ? `${city}${!opts.city && cr.state ? `/${cr.state}` : ''}` : FILL;
  if (!city) missing.push('Cidade');
  const forum = opts.forum || lending.forumCity || (cr.city ? `${cr.city}${cr.state ? `/${cr.state}` : ''}` : '');
  if (!forum) missing.push('Foro (cidade/UF)');
  const disb = opts.disbursementMethod || loan.disbursementMethod || '';
  if (!disb) missing.push('Forma de entrega do dinheiro (PIX/transferência/dinheiro)');
  const payMethod = opts.paymentMethod || (cr.pixKey ? `PIX para a chave ${cr.pixKey}` : '');
  if (!payMethod) missing.push('Forma de pagamento (chave PIX ou outra)');
  const accel = opts.accelerationDays ?? lending.accelerationDays;
  const quit = opts.quitationDays ?? lending.quitationDays;
  const date = opts.date ? dateOnly(opts.date) : today;
  const amount = loan.principalAmount;

  const text = [
    'CONTRATO DE EMPRÉSTIMO (MÚTUO) ENTRE PARTICULARES',
    `CREDOR: ${credor}.\nDEVEDOR: ${devedor}.`,
    `Cláusula 1 - Objeto. O CREDOR empresta ao DEVEDOR a quantia de R$ ${brlPlain(amount)} (${valorPorExtenso(amount)}), entregue em ${formatBRDate(loan.disbursementDate)} por ${disb || FILL}, que o DEVEDOR declara ter recebido.`,
    `Cláusula 2 - Juros. Incidem juros de ${pctText(loan.periodRate ?? 0)}% ${RATE_PERIOD_TEXT[loan.periodicity]}, calculados sobre o saldo devedor existente em cada período.`,
    `Cláusula 3 - Pagamento. O DEVEDOR pagará a dívida em ${paymentClause(loan)}, por meio de ${payMethod || FILL}.`,
    'Cláusula 4 - Pagamento parcial ou antecipado. O DEVEDOR pode pagar qualquer valor antes do vencimento. Todo pagamento quita primeiro os juros vencidos e depois o principal. Os juros seguintes incidem apenas sobre o saldo restante.',
    `Cláusula 5 - Atraso. O atraso gera multa de ${pctText(loan.lateFineRate)}% sobre o valor vencido e juros de mora de ${pctText(loan.lateInterestMonthly)}% ao mês, proporcionais aos dias de atraso.`,
    `Cláusula 6 - Vencimento antecipado. O atraso superior a ${accel} dias em qualquer parcela torna exigível todo o saldo devedor.`,
    `Cláusula 7 - Garantia. ${opts.guarantee?.trim() || 'Não há garantia vinculada a este contrato.'}`,
    `Cláusula 8 - Recibos e quitação. O CREDOR dará recibo de cada pagamento e, quitada a dívida, entregará termo de quitação em até ${quit} dias.`,
    'Cláusula 9 - Disposições gerais. Qualquer alteração só vale por escrito e assinada pelas duas partes. Este contrato obriga herdeiros e sucessores.',
    `Cláusula 10 - Foro. Fica eleito o foro da comarca de ${forum || FILL}.`,
    `${cityUF}, ${formatBRDate(date)}.`,
    `CREDOR: ______________________________\n${cr.name || FILL}`,
    `DEVEDOR: ______________________________\n${c.name}`,
    `Testemunha 1: ______________________________\n${opts.witness1?.trim() || 'Nome e CPF: ________________________'}`,
    `Testemunha 2: ______________________________\n${opts.witness2?.trim() || 'Nome e CPF: ________________________'}`,
  ].join('\n\n');
  return { text, missing };
}

/** Converte o texto (parágrafos separados por linha em branco) em blocos de PDF. */
export function contractBlocks(text: string): Block[] {
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras.flatMap((p, idx): Block[] => {
    if (idx === 0) return [{ type: 'title', text: p }];
    if (/_{5,}/.test(p)) return [{ type: 'spacer', size: 1.2 }, ...p.split('\n').map((l): Block => ({ type: 'paragraph', text: l.trim() }))];
    return p.split('\n').map((l): Block => ({ type: 'paragraph', text: l.trim() }));
  });
}

export async function saveContract(ctx: AuthContext, loanId: string, text: string) {
  const companyId = ctx.companyId!;
  const loan = await prisma.loan.findFirst({ where: { id: loanId, companyId } });
  if (!loan) throw notFound('Empréstimo não encontrado');
  if (loan.engine !== 'BALANCE') throw badRequest('Use a tela de contratos para empréstimos com parcelas pré-calculadas');
  if (text.trim().length < 50) throw badRequest('O texto do contrato está vazio');
  const version = (await prisma.contract.count({ where: { loanId } })) + 1;
  const pdf = await renderPdf(contractBlocks(text), { title: `Contrato ${loan.number} v${version}`, header: `Contrato de empréstimo nº ${loan.number} · versão ${version}`, footer: 'Documento gerado eletronicamente.' });
  const file = await storeFile(companyId, `contrato-${loan.number}-v${version}.pdf`, 'application/pdf', pdf, ctx.userId);
  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.create({ data: { companyId, loanId, version, kind: 'CONTRACT', status: 'DRAFT', renderedContent: text, fileId: file.id, sha256: sha256(pdf), createdById: ctx.userId }, include: { file: { select: { id: true, filename: true } } } });
    await addEvent(tx, loanId, 'CONTRACT_GENERATED', ctx, { contractId: contract.id, version });
    await audit(ctx, { action: 'CONTRACT_GENERATE', entity: 'Contract', entityId: contract.id, after: { loanId, version, sha256: contract.sha256 } }, tx);
    return contract;
  });
}

export async function markContractSigned(ctx: AuthContext, contractId: string) {
  const c = await prisma.contract.findFirst({ where: { id: contractId, companyId: ctx.companyId! }, include: { loan: true } });
  if (!c) throw notFound('Contrato não encontrado');
  const updated = await prisma.contract.update({ where: { id: c.id }, data: { status: 'SIGNED', signedAt: new Date() } });
  await addEvent(prisma, c.loanId, 'SIGNED', ctx, { contractId: c.id, version: c.version });
  await audit(ctx, { action: 'CONTRACT_SIGNED', entity: 'Contract', entityId: c.id, after: { manual: true } });
  return updated;
}

export async function deleteContract(ctx: AuthContext, contractId: string) {
  const c = await prisma.contract.findFirst({ where: { id: contractId, companyId: ctx.companyId! }, include: { loan: { select: { engine: true } } } });
  if (!c) throw notFound('Contrato não encontrado');
  if (c.loan.engine !== 'BALANCE') throw badRequest('Contratos de empréstimos com parcelas são cancelados, não excluídos');
  await prisma.contractSigner.deleteMany({ where: { contractId: c.id } });
  await prisma.contract.delete({ where: { id: c.id } });
  await addEvent(prisma, c.loanId, 'CONTRACT_DELETED', ctx, { version: c.version });
  await audit(ctx, { action: 'CONTRACT_DELETE', entity: 'Contract', entityId: c.id, before: { version: c.version, sha256: c.sha256 } });
}
