import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';
import { computeBalance } from '../../domain/installment.js';
import { dateOnly, formatBRDate, monthKey, monthRange, previousMonthKey, todayIn, formatBRDateTime } from '../../lib/dates.js';
import { D, sum, formatBRL, formatPct, type Dec } from '../../lib/money.js';
import { renderPdf, type Block } from '../../services/pdf.js';
import { audit } from '../../lib/audit.js';
import type { AuthContext } from '../../middleware/auth.js';
import { notFound } from '../../lib/errors.js';
import { companyTimezone } from '../loans/loans.service.js';

const f2 = (d: Dec | number | string) => D(d).toFixed(2);

export const INDICATOR_FORMULAS = {
  overdueRate: 'Inadimplência (valor) = saldo vencido (parcelas em atraso, com encargos) ÷ saldo total a receber (todas as parcelas em aberto de contratos ativos) × 100',
  overdueClientsRate: 'Inadimplência (clientes) = clientes com ao menos uma parcela em atraso ÷ clientes com contratos ativos × 100',
  overdue30Rate: 'Inadimplência 30+ = saldo das parcelas com mais de 30 dias de atraso ÷ saldo total a receber × 100',
  principalRecovered: 'Principal recuperado = soma da parcela de principal dos pagamentos confirmados no período (devolução de capital; não é lucro)',
  interestReceived: 'Juros recebidos = soma da parcela de juros dos pagamentos confirmados no período (resultado financeiro)',
};

interface PeriodFilter { from: Date; to: Date; clientId?: string; loanId?: string; userId?: string }

async function paymentsIn(companyId: string, p: PeriodFilter) {
  return prisma.payment.findMany({
    where: { companyId, paidAt: { gte: p.from, lte: p.to }, ...(p.clientId ? { clientId: p.clientId } : {}), ...(p.loanId ? { loanId: p.loanId } : {}), ...(p.userId ? { receivedById: p.userId } : {}) },
    include: { client: { select: { id: true, name: true } }, loan: { select: { id: true, number: true } }, installment: { select: { number: true, dueDate: true } } },
    orderBy: { paidAt: 'asc' },
  });
}

export async function dashboard(companyId: string, from: Date, to: Date) {
  const tz = await companyTimezone(companyId);
  const today = todayIn(tz);
  const [loansDisbursed, payments, openInstallments, activeClients] = await Promise.all([
    prisma.loan.findMany({ where: { companyId, status: { in: ['ACTIVE', 'PAID', 'RENEGOTIATED'] }, disbursedAt: { gte: from, lte: to }, parentLoanId: null }, select: { id: true, number: true, disbursedAmount: true, principalAmount: true, disbursedAt: true, client: { select: { name: true } } } }),
    paymentsIn(companyId, { from, to }),
    prisma.installment.findMany({ where: { companyId, status: { in: ['PENDING', 'PARTIAL'] }, loan: { status: 'ACTIVE' } }, include: { loan: { select: { id: true, clientId: true, lateFineRate: true, lateInterestMonthly: true } } } }),
    prisma.loan.groupBy({ by: ['clientId'], where: { companyId, status: 'ACTIVE' } }),
  ]);
  const confirmed = payments.filter((p) => p.status === 'CONFIRMED' && p.source !== 'RENEGOTIATION');
  const reversed = payments.filter((p) => p.status === 'REVERSED');
  const balances = openInstallments.map((i) => ({ i, b: computeBalance(i, i.loan, today) }));
  const openTotal = sum(balances.map((x) => x.b.totalDue));
  const overdue = balances.filter((x) => x.b.daysLate > 0);
  const overdueTotal = sum(overdue.map((x) => x.b.totalDue));
  const overdue30 = sum(overdue.filter((x) => x.b.daysLate > 30).map((x) => x.b.totalDue));
  const dueToday = balances.filter((x) => dateOnly(x.i.dueDate).getTime() === today.getTime());
  const overdueClients = new Set(overdue.map((x) => x.i.loan.clientId));
  const expectedInPeriod = await prisma.installment.findMany({ where: { companyId, dueDate: { gte: from, lte: to }, status: { not: 'CANCELLED' }, loan: { status: { in: ['ACTIVE', 'PAID', 'RENEGOTIATED'] } } }, select: { originalAmount: true, status: true } });
  const pct = (a: Dec, b: Dec) => (b.isZero() ? '0.00' : a.div(b).times(100).toFixed(2));
  return {
    period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    today: today.toISOString().slice(0, 10),
    disbursed: { count: loansDisbursed.length, amount: f2(sum(loansDisbursed.map((l) => l.disbursedAmount))), principal: f2(sum(loansDisbursed.map((l) => l.principalAmount))) },
    received: { count: confirmed.length, total: f2(sum(confirmed.map((p) => p.amount))), principal: f2(sum(confirmed.map((p) => p.principalPortion))), interest: f2(sum(confirmed.map((p) => p.interestPortion))), charges: f2(sum(confirmed.map((p) => p.chargesPortion))), discounts: f2(sum(confirmed.map((p) => p.discountAmount))) },
    reversed: { count: reversed.length, amount: f2(sum(reversed.map((p) => p.amount))) },
    expected: { count: expectedInPeriod.length, amount: f2(sum(expectedInPeriod.map((i) => i.originalAmount))) },
    openBalance: f2(openTotal),
    openPrincipal: f2(sum(balances.map((x) => x.b.principalOpen))),
    overdue: { count: overdue.length, amount: f2(overdueTotal), clients: overdueClients.size, over30: f2(overdue30) },
    dueToday: { count: dueToday.length, amount: f2(sum(dueToday.map((x) => x.b.totalDue))) },
    activeClients: activeClients.length,
    indicators: { overdueRate: pct(overdueTotal, openTotal), overdueClientsRate: pct(D(overdueClients.size), D(activeClients.length)), overdue30Rate: pct(overdue30, openTotal) },
    formulas: INDICATOR_FORMULAS,
  };
}

/** Composição completa de um mês (base do fechamento mensal). */
export async function buildMonthlyReport(companyId: string, month: string, referenceDate = new Date()) {
  const { start, end } = monthRange(month);
  const to = new Date(end.getTime() - 1);
  const tz = await companyTimezone(companyId);
  const asOf = referenceDate < end ? todayIn(tz, referenceDate) : dateOnly(to);
  const [loans, payments, expenses, installmentsAll] = await Promise.all([
    prisma.loan.findMany({ where: { companyId, disbursedAt: { gte: start, lt: end }, parentLoanId: null, status: { in: ['ACTIVE', 'PAID', 'RENEGOTIATED'] } }, select: { id: true, number: true, disbursedAmount: true, principalAmount: true, disbursedAt: true, installmentsCount: true, client: { select: { name: true } } } }),
    paymentsIn(companyId, { from: start, to }),
    prisma.expense.findMany({ where: { companyId, date: { gte: start, lt: end } }, orderBy: { date: 'asc' } }),
    prisma.installment.findMany({ where: { companyId, status: { not: 'CANCELLED' }, loan: { status: { in: ['ACTIVE', 'PAID', 'RENEGOTIATED'] } } }, include: { loan: { select: { id: true, number: true, clientId: true, status: true, lateFineRate: true, lateInterestMonthly: true, client: { select: { name: true } } } } } }),
  ]);
  const confirmed = payments.filter((p) => p.status === 'CONFIRMED' && p.source !== 'RENEGOTIATION');
  const reversed = payments.filter((p) => p.status === 'REVERSED');
  const renegotiated = payments.filter((p) => p.source === 'RENEGOTIATION');
  // atrasos na data de referência (parcelas em aberto vencidas até o fim do mês)
  const openAtRef = installmentsAll.filter((i) => ['PENDING', 'PARTIAL'].includes(i.status) && i.loan.status === 'ACTIVE');
  const overdue = openAtRef.map((i) => ({ i, b: computeBalance(i, i.loan, asOf) })).filter((x) => x.b.daysLate > 0);
  const nextRange = monthRange(monthKey(end));
  const projection = installmentsAll.filter((i) => ['PENDING', 'PARTIAL'].includes(i.status) && i.loan.status === 'ACTIVE' && i.dueDate >= nextRange.start && i.dueDate < nextRange.end);
  const pmtRow = (p: (typeof payments)[number]) => ({ id: p.id, paidAt: p.paidAt.toISOString().slice(0, 10), client: p.client.name, loan: p.loan.number, installment: p.installment?.number ?? '—', amount: f2(p.amount), principal: f2(p.principalPortion), interest: f2(p.interestPortion), charges: f2(p.chargesPortion), discount: f2(p.discountAmount), method: p.method, source: p.source, receivedBy: p.receivedByName, receiptNumber: p.receiptNumber, reason: p.reversalReason });
  const data = {
    month,
    referenceDate: referenceDate.toISOString(),
    asOf: asOf.toISOString().slice(0, 10),
    totals: {
      disbursedCount: loans.length,
      disbursedAmount: f2(sum(loans.map((l) => l.disbursedAmount))),
      principalFinanced: f2(sum(loans.map((l) => l.principalAmount))),
      receivedTotal: f2(sum(confirmed.map((p) => p.amount))),
      receivedCount: confirmed.length,
      principal: f2(sum(confirmed.map((p) => p.principalPortion))),
      interest: f2(sum(confirmed.map((p) => p.interestPortion))),
      charges: f2(sum(confirmed.map((p) => p.chargesPortion))),
      discounts: f2(sum(confirmed.map((p) => p.discountAmount))),
      reversals: f2(sum(reversed.map((p) => p.amount))),
      reversalsCount: reversed.length,
      renegotiatedBalance: f2(sum(renegotiated.map((p) => p.discountAmount))),
      expenses: f2(sum(expenses.map((e) => e.amount))),
      result: f2(sum(confirmed.map((p) => p.interestPortion)).plus(sum(confirmed.map((p) => p.chargesPortion))).minus(sum(expenses.map((e) => e.amount)))),
      overdueCount: overdue.length,
      overdueAmount: f2(sum(overdue.map((x) => x.b.totalDue))),
      overdueClients: new Set(overdue.map((x) => x.i.loan.clientId)).size,
      projectionCount: projection.length,
      projectionAmount: f2(sum(projection.map((i) => D(i.originalAmount).minus(i.paidPrincipal).minus(i.paidInterest)))),
      projectionMonth: monthKey(end),
    },
    details: {
      loans: loans.map((l) => ({ id: l.id, number: l.number, client: l.client.name, disbursedAt: l.disbursedAt?.toISOString().slice(0, 10), disbursed: f2(l.disbursedAmount), principal: f2(l.principalAmount), installments: l.installmentsCount })),
      payments: confirmed.map(pmtRow),
      reversals: reversed.map(pmtRow),
      expenses: expenses.map((e) => ({ id: e.id, date: e.date.toISOString().slice(0, 10), description: e.description, category: e.category, amount: f2(e.amount) })),
      overdue: overdue.map((x) => ({ id: x.i.id, client: x.i.loan.client.name, loan: x.i.loan.number, installment: x.i.number, dueDate: x.i.dueDate.toISOString().slice(0, 10), daysLate: x.b.daysLate, amount: f2(x.b.totalDue) })).sort((a, b) => b.daysLate - a.daysLate),
      projection: projection.map((i) => ({ id: i.id, client: i.loan.client.name, loan: i.loan.number, installment: i.number, dueDate: i.dueDate.toISOString().slice(0, 10), amount: f2(D(i.originalAmount).minus(i.paidPrincipal).minus(i.paidInterest)) })).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    },
    formulas: INDICATOR_FORMULAS,
  };
  return data;
}
export type MonthlyData = Awaited<ReturnType<typeof buildMonthlyReport>>;

export async function closeMonth(companyId: string, month: string, ctx: Partial<AuthContext> | null, automatic = false) {
  const data = await buildMonthlyReport(companyId, month);
  const prev = await prisma.monthlyReport.findFirst({ where: { companyId, referenceMonth: previousMonthKey(month) }, orderBy: { version: 'desc' } });
  const previous = prev ? (prev.data as MonthlyData).totals : (await buildMonthlyReport(companyId, previousMonthKey(month))).totals;
  const last = await prisma.monthlyReport.findFirst({ where: { companyId, referenceMonth: month }, orderBy: { version: 'desc' } });
  const report = await prisma.monthlyReport.create({ data: { companyId, referenceMonth: month, version: (last?.version ?? 0) + 1, referenceDate: new Date(), generatedById: ctx?.userId && ctx.userId !== 'system' ? ctx.userId : null, automatic, data: { ...data, previous } as never } });
  await audit({ ...ctx, companyId }, { action: automatic ? 'MONTHLY_REPORT_AUTO' : 'MONTHLY_REPORT_CLOSE', entity: 'MonthlyReport', entityId: report.id, after: { month, version: report.version } });
  return report;
}

/** Fechamento automático do mês anterior para todas as empresas que ainda não o possuem. */
export async function closePreviousMonthForAll(now = new Date()) {
  const month = previousMonthKey(monthKey(now));
  const companies = await prisma.company.findMany({ where: { status: { in: ['ACTIVE', 'TRIAL'] } }, select: { id: true, name: true } });
  const out: Record<string, string> = {};
  for (const c of companies) {
    const exists = await prisma.monthlyReport.findFirst({ where: { companyId: c.id, referenceMonth: month } });
    if (exists) { out[c.name] = 'já fechado'; continue; }
    try { const r = await closeMonth(c.id, month, null, true); out[c.name] = `fechado v${r.version}`; } catch (e) { out[c.name] = `erro: ${(e as Error).message}`; }
  }
  return { month, ...out };
}

export async function getReport(companyId: string, id: string) {
  const r = await prisma.monthlyReport.findFirst({ where: { id, companyId } });
  if (!r) throw notFound('Fechamento não encontrado');
  return r;
}

const MONTH_LABEL = (m: string) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm - 1, 1)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };

export async function monthlyPdf(companyId: string, data: MonthlyData & { previous?: MonthlyData['totals'] }, meta: { version: number; referenceDate: Date }) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const t = data.totals; const p = data.previous;
  const cmp = (a: string, b?: string) => (b === undefined ? formatBRL(a) : `${formatBRL(a)} (mês anterior ${formatBRL(b)})`);
  const blocks: Block[] = [
    { type: 'title', text: `Relatório mensal — ${MONTH_LABEL(data.month)}` },
    { type: 'small', text: `${company.name} · fechamento versão ${meta.version} · data de referência ${formatBRDateTime(meta.referenceDate, company.timezone)} · posição de atrasos em ${formatBRDate(data.asOf)}` },
    { type: 'heading', text: 'Resumo' },
    { type: 'kv', rows: [
      ['Empréstimos liberados', `${t.disbursedCount} contrato(s) · ${cmp(t.disbursedAmount, p?.disbursedAmount)}`],
      ['Recebimentos confirmados', `${t.receivedCount} pagamento(s) · ${cmp(t.receivedTotal, p?.receivedTotal)}`],
      ['Principal recuperado (não é lucro)', cmp(t.principal, p?.principal)],
      ['Juros recebidos', cmp(t.interest, p?.interest)],
      ['Encargos de atraso recebidos', cmp(t.charges, p?.charges)],
      ['Descontos concedidos', cmp(t.discounts, p?.discounts)],
      ['Estornos', `${t.reversalsCount} · ${cmp(t.reversals, p?.reversals)}`],
      ['Saldos transferidos por renegociação', formatBRL(t.renegotiatedBalance)],
      ['Despesas', cmp(t.expenses, p?.expenses)],
      ['Resultado (juros + encargos - despesas)', cmp(t.result, p?.result)],
      ['Parcelas em atraso na referência', `${t.overdueCount} parcela(s) de ${t.overdueClients} cliente(s) · ${formatBRL(t.overdueAmount)}`],
      [`Projeção de vencimentos (${MONTH_LABEL(t.projectionMonth)})`, `${t.projectionCount} parcela(s) · ${formatBRL(t.projectionAmount)}`],
    ] },
    { type: 'heading', text: 'Empréstimos liberados' },
    { type: 'table', columns: [{ label: 'Nº', width: 0.5 }, { label: 'Cliente', width: 2 }, { label: 'Liberação', width: 1 }, { label: 'Liberado', width: 1, align: 'right' }, { label: 'Principal', width: 1, align: 'right' }, { label: 'Parc.', width: 0.5, align: 'right' }], rows: data.details.loans.map((l) => [String(l.number), l.client, formatBRDate(l.disbursedAt), formatBRL(l.disbursed), formatBRL(l.principal), String(l.installments)]) },
    { type: 'heading', text: 'Recebimentos' },
    { type: 'table', columns: [{ label: 'Data', width: 0.9 }, { label: 'Cliente', width: 2 }, { label: 'Contr./Parc.', width: 1.1 }, { label: 'Valor', width: 0.9, align: 'right' }, { label: 'Principal', width: 0.9, align: 'right' }, { label: 'Juros', width: 0.9, align: 'right' }, { label: 'Encargos', width: 0.9, align: 'right' }, { label: 'Desc.', width: 0.8, align: 'right' }], rows: data.details.payments.map((r) => [formatBRDate(r.paidAt), r.client, `${r.loan}/${r.installment}`, formatBRL(r.amount), formatBRL(r.principal), formatBRL(r.interest), formatBRL(r.charges), formatBRL(r.discount)]) },
    { type: 'heading', text: 'Estornos' },
    { type: 'table', columns: [{ label: 'Data', width: 1 }, { label: 'Cliente', width: 2 }, { label: 'Valor', width: 1, align: 'right' }, { label: 'Justificativa', width: 3 }], rows: data.details.reversals.map((r) => [formatBRDate(r.paidAt), r.client, formatBRL(r.amount), r.reason ?? '']) },
    { type: 'heading', text: 'Despesas' },
    { type: 'table', columns: [{ label: 'Data', width: 1 }, { label: 'Descrição', width: 3 }, { label: 'Categoria', width: 1.5 }, { label: 'Valor', width: 1, align: 'right' }], rows: data.details.expenses.map((e) => [formatBRDate(e.date), e.description, e.category, formatBRL(e.amount)]) },
    { type: 'heading', text: 'Parcelas em atraso na data de referência' },
    { type: 'table', columns: [{ label: 'Cliente', width: 2 }, { label: 'Contr./Parc.', width: 1 }, { label: 'Vencimento', width: 1 }, { label: 'Dias', width: 0.6, align: 'right' }, { label: 'Saldo', width: 1, align: 'right' }], rows: data.details.overdue.map((o) => [o.client, `${o.loan}/${o.installment}`, formatBRDate(o.dueDate), String(o.daysLate), formatBRL(o.amount)]) },
    { type: 'heading', text: `Projeção de vencimentos — ${MONTH_LABEL(t.projectionMonth)}` },
    { type: 'table', columns: [{ label: 'Cliente', width: 2 }, { label: 'Contr./Parc.', width: 1 }, { label: 'Vencimento', width: 1 }, { label: 'Valor', width: 1, align: 'right' }], rows: data.details.projection.map((o) => [o.client, `${o.loan}/${o.installment}`, formatBRDate(o.dueDate), formatBRL(o.amount)]) },
    { type: 'heading', text: 'Fórmulas dos indicadores' },
    ...Object.values(INDICATOR_FORMULAS).map((f): Block => ({ type: 'small', text: f.replace(/÷/g, '/').replace(/×/g, 'x') })),
  ];
  return renderPdf(blocks, { title: `Relatório ${data.month}`, header: `${company.name} · Relatório mensal ${data.month} · v${meta.version}`, footer: 'Valores em reais. Principal recuperado é devolução de capital e não compõe o resultado.' });
}

export async function monthlyXlsx(data: MonthlyData & { previous?: MonthlyData['totals'] }, meta: { version: number }) {
  const wb = new ExcelJS.Workbook();
  const money = '"R$" #,##0.00';
  const resumo = wb.addWorksheet('Resumo');
  resumo.columns = [{ header: 'Indicador', width: 48 }, { header: 'Mês', width: 18 }, { header: 'Mês anterior', width: 18 }];
  const t = data.totals; const p = data.previous;
  const rows: Array<[string, string | number, string | number | undefined]> = [
    ['Mês de referência', data.month, ''], ['Versão do fechamento', meta.version, ''], ['Posição de atrasos em', data.asOf, ''],
    ['Empréstimos liberados (quantidade)', t.disbursedCount, p?.disbursedCount], ['Empréstimos liberados (valor)', Number(t.disbursedAmount), p ? Number(p.disbursedAmount) : undefined],
    ['Recebimentos confirmados', Number(t.receivedTotal), p ? Number(p.receivedTotal) : undefined], ['Principal recuperado (não é lucro)', Number(t.principal), p ? Number(p.principal) : undefined], ['Juros recebidos', Number(t.interest), p ? Number(p.interest) : undefined], ['Encargos recebidos', Number(t.charges), p ? Number(p.charges) : undefined], ['Descontos', Number(t.discounts), p ? Number(p.discounts) : undefined], ['Estornos', Number(t.reversals), p ? Number(p.reversals) : undefined], ['Despesas', Number(t.expenses), p ? Number(p.expenses) : undefined], ['Resultado (juros + encargos − despesas)', Number(t.result), p ? Number(p.result) : undefined],
    ['Parcelas em atraso (quantidade)', t.overdueCount, p?.overdueCount], ['Parcelas em atraso (valor)', Number(t.overdueAmount), p ? Number(p.overdueAmount) : undefined], ['Clientes em atraso', t.overdueClients, p?.overdueClients], [`Projeção ${t.projectionMonth} (valor)`, Number(t.projectionAmount), undefined],
  ];
  rows.forEach((r) => resumo.addRow(r));
  resumo.getColumn(2).numFmt = money; resumo.getColumn(3).numFmt = money;
  resumo.getRow(1).font = { bold: true };
  const sheet = (name: string, cols: Array<{ header: string; key: string; width?: number; money?: boolean }>, data: Array<Record<string, unknown>>) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16 }));
    data.forEach((d) => ws.addRow(Object.fromEntries(cols.map((c) => [c.key, c.money ? Number(d[c.key] ?? 0) : d[c.key]]))));
    cols.forEach((c, i) => { if (c.money) ws.getColumn(i + 1).numFmt = money; });
    ws.getRow(1).font = { bold: true };
  };
  sheet('Emprestimos liberados', [{ header: 'Nº', key: 'number', width: 8 }, { header: 'Cliente', key: 'client', width: 36 }, { header: 'Liberação', key: 'disbursedAt' }, { header: 'Liberado', key: 'disbursed', money: true }, { header: 'Principal', key: 'principal', money: true }, { header: 'Parcelas', key: 'installments', width: 10 }], data.details.loans);
  sheet('Recebimentos', [{ header: 'Data', key: 'paidAt' }, { header: 'Cliente', key: 'client', width: 36 }, { header: 'Contrato', key: 'loan', width: 10 }, { header: 'Parcela', key: 'installment', width: 10 }, { header: 'Valor', key: 'amount', money: true }, { header: 'Principal', key: 'principal', money: true }, { header: 'Juros', key: 'interest', money: true }, { header: 'Encargos', key: 'charges', money: true }, { header: 'Desconto', key: 'discount', money: true }, { header: 'Forma', key: 'method' }, { header: 'Origem', key: 'source' }, { header: 'Recebido por', key: 'receivedBy', width: 28 }, { header: 'Recibo', key: 'receiptNumber', width: 10 }], data.details.payments);
  sheet('Estornos', [{ header: 'Data', key: 'paidAt' }, { header: 'Cliente', key: 'client', width: 36 }, { header: 'Contrato', key: 'loan' }, { header: 'Parcela', key: 'installment' }, { header: 'Valor', key: 'amount', money: true }, { header: 'Justificativa', key: 'reason', width: 48 }], data.details.reversals);
  sheet('Despesas', [{ header: 'Data', key: 'date' }, { header: 'Descrição', key: 'description', width: 40 }, { header: 'Categoria', key: 'category' }, { header: 'Valor', key: 'amount', money: true }], data.details.expenses);
  sheet('Atrasos', [{ header: 'Cliente', key: 'client', width: 36 }, { header: 'Contrato', key: 'loan' }, { header: 'Parcela', key: 'installment' }, { header: 'Vencimento', key: 'dueDate' }, { header: 'Dias de atraso', key: 'daysLate' }, { header: 'Saldo', key: 'amount', money: true }], data.details.overdue);
  sheet('Projecao', [{ header: 'Cliente', key: 'client', width: 36 }, { header: 'Contrato', key: 'loan' }, { header: 'Parcela', key: 'installment' }, { header: 'Vencimento', key: 'dueDate' }, { header: 'Valor', key: 'amount', money: true }], data.details.projection);
  const formulas = wb.addWorksheet('Formulas');
  formulas.columns = [{ header: 'Indicador', width: 30 }, { header: 'Fórmula', width: 120 }];
  Object.entries(INDICATOR_FORMULAS).forEach(([k, v]) => formulas.addRow([k, v]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function receiptsExtract(companyId: string, p: PeriodFilter) {
  const rows = await paymentsIn(companyId, p);
  return rows.map((r) => ({ id: r.id, paidAt: r.paidAt.toISOString().slice(0, 10), client: r.client.name, clientId: r.clientId, loan: r.loan.number, loanId: r.loanId, installment: r.installment?.number ?? '—', amount: f2(r.amount), principal: f2(r.principalPortion), interest: f2(r.interestPortion), charges: f2(r.chargesPortion), discount: f2(r.discountAmount), method: r.method, source: r.source, status: r.status, receivedBy: r.receivedByName, receiptNumber: r.receiptNumber }));
}

export async function receiptsXlsx(rows: Awaited<ReturnType<typeof receiptsExtract>>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Recebimentos');
  ws.columns = [{ header: 'Data', key: 'paidAt', width: 12 }, { header: 'Cliente', key: 'client', width: 36 }, { header: 'Contrato', key: 'loan', width: 10 }, { header: 'Parcela', key: 'installment', width: 10 }, { header: 'Valor', key: 'amount', width: 14 }, { header: 'Principal', key: 'principal', width: 14 }, { header: 'Juros', key: 'interest', width: 14 }, { header: 'Encargos', key: 'charges', width: 14 }, { header: 'Desconto', key: 'discount', width: 14 }, { header: 'Forma', key: 'method', width: 12 }, { header: 'Origem', key: 'source', width: 16 }, { header: 'Situação', key: 'status', width: 16 }, { header: 'Recebido por', key: 'receivedBy', width: 28 }, { header: 'Recibo', key: 'receiptNumber', width: 10 }];
  rows.forEach((r) => ws.addRow({ ...r, amount: Number(r.amount), principal: Number(r.principal), interest: Number(r.interest), charges: Number(r.charges), discount: Number(r.discount) }));
  [5, 6, 7, 8, 9].forEach((i) => { ws.getColumn(i).numFmt = '"R$" #,##0.00'; });
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export { formatPct };
