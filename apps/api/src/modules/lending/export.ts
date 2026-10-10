/** Exportação (Excel/CSV) e backup completo dos dados da empresa. */
import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';
import { todayIn, formatBRDate } from '../../lib/dates.js';
import { companyTimezone } from '../loans/loans.service.js';
import { ledgerOf, readSettings, BILLING_LABEL } from './lending.service.js';
import { maskDoc } from '../../lib/text.js';

const STATUS_LABEL: Record<string, string> = { ON_TIME: 'Em dia', DUE_TODAY: 'Vence hoje', DUE_THIS_WEEK: 'Vence esta semana', OVERDUE: 'Atrasado', PAID: 'Quitado' };
const PERIOD_LABEL: Record<string, string> = { DAILY: 'ao dia', WEEKLY: 'por semana', BIWEEKLY: 'por quinzena', MONTHLY: 'ao mês' };
const METHOD_LABEL: Record<string, string> = { PIX: 'Pix', BOLETO: 'Boleto', CASH: 'Dinheiro', TRANSFER: 'Transferência', CARD: 'Cartão', OTHER: 'Outro' };

interface Col { header: string; key: string; width?: number; money?: boolean }
type Row = Record<string, string | number | null>;

export async function exportData(companyId: string) {
  const today = todayIn(await companyTimezone(companyId));
  const [clients, loans, payments] = await Promise.all([
    prisma.client.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
    prisma.loan.findMany({ where: { companyId, engine: 'BALANCE' }, include: { client: { select: { name: true } }, payments: { where: { status: 'CONFIRMED' }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] } }, orderBy: { number: 'asc' } }),
    prisma.payment.findMany({ where: { companyId, status: 'CONFIRMED' }, include: { client: { select: { name: true } }, loan: { select: { number: true } } }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  const clientCols: Col[] = [
    { header: 'Nome', key: 'name', width: 34 }, { header: 'CPF/CNPJ', key: 'document', width: 18 }, { header: 'RG', key: 'rg' }, { header: 'Telefone', key: 'phone' },
    { header: 'Endereço', key: 'address', width: 44 }, { header: 'Estado civil', key: 'maritalStatus' }, { header: 'Profissão', key: 'profession' }, { header: 'Observações', key: 'notes', width: 40 },
  ];
  const clientRows: Row[] = clients.map((c) => ({
    name: c.name, document: maskDoc(c.document), rg: c.rg, phone: c.phone, maritalStatus: c.maritalStatus, profession: c.profession, notes: c.notes,
    address: [c.addressStreet, c.addressNumber, c.addressComplement, c.addressDistrict, c.addressCity && `${c.addressCity}/${c.addressState ?? ''}`, c.addressZip].filter(Boolean).join(', '),
  }));
  const loanCols: Col[] = [
    { header: 'Nº', key: 'number', width: 8 }, { header: 'Cliente', key: 'client', width: 30 }, { header: 'Situação', key: 'status' }, { header: 'Tipo de cobrança', key: 'billing', width: 36 },
    { header: 'Taxa', key: 'rate', width: 16 }, { header: 'Data do empréstimo', key: 'start' }, { header: 'Vencimento', key: 'maturity' },
    { header: 'Valor emprestado', key: 'principal', money: true }, { header: 'Juros acumulados', key: 'interestAccrued', money: true }, { header: 'Encargos de atraso', key: 'chargesAccrued', money: true },
    { header: 'Total pago', key: 'totalPaid', money: true }, { header: 'Saldo devedor', key: 'balance', money: true }, { header: 'Total a receber', key: 'totalToReceive', money: true },
    { header: 'Próximo vencimento', key: 'nextDue' }, { header: 'Valor do próximo vencimento', key: 'nextDueAmount', money: true }, { header: 'Dias de atraso', key: 'daysLate', width: 10 },
  ];
  const loanRows: Row[] = loans.map((l) => {
    const r = ledgerOf(l, l.payments, today);
    return {
      number: l.number, client: l.client.name, status: STATUS_LABEL[r.status], billing: BILLING_LABEL[l.billingType ?? ''] ?? '',
      rate: `${l.periodRate?.toString().replace('.', ',')}% ${PERIOD_LABEL[l.periodicity]}`, start: formatBRDate(l.disbursementDate), maturity: formatBRDate(l.maturityDate),
      principal: r.principal.toFixed(2), interestAccrued: r.interestAccrued.toFixed(2), chargesAccrued: r.chargesAccrued.toFixed(2), totalPaid: r.totalPaid.toFixed(2),
      balance: r.balance.toFixed(2), totalToReceive: r.totalToReceive.toFixed(2), nextDue: r.nextDue ? formatBRDate(r.nextDue.date) : '', nextDueAmount: r.nextDue ? r.nextDue.amount.toFixed(2) : '0', daysLate: r.daysLate,
    };
  });
  const paymentCols: Col[] = [
    { header: 'Data', key: 'date' }, { header: 'Cliente', key: 'client', width: 30 }, { header: 'Empréstimo', key: 'loan', width: 10 }, { header: 'Valor pago', key: 'amount', money: true },
    { header: 'Juros', key: 'interest', money: true }, { header: 'Principal', key: 'principal', money: true }, { header: 'Encargos', key: 'charges', money: true },
    { header: 'Saldo após', key: 'balanceAfter', money: true }, { header: 'Forma', key: 'method' }, { header: 'Recibo', key: 'receipt', width: 10 }, { header: 'Observações', key: 'notes', width: 36 },
  ];
  const paymentRows: Row[] = payments.map((p) => ({
    date: formatBRDate(p.paidAt), client: p.client.name, loan: p.loan.number, amount: p.amount.toFixed(2), interest: p.interestPortion.toFixed(2), principal: p.principalPortion.toFixed(2),
    charges: p.chargesPortion.toFixed(2), balanceAfter: p.balanceAfter?.toFixed(2) ?? '', method: METHOD_LABEL[p.method] ?? p.method, receipt: p.receiptNumber, notes: p.notes,
  }));
  return { clients: { cols: clientCols, rows: clientRows }, loans: { cols: loanCols, rows: loanRows }, payments: { cols: paymentCols, rows: paymentRows } };
}

export async function exportXlsx(companyId: string) {
  const data = await exportData(companyId);
  const wb = new ExcelJS.Workbook();
  const add = (name: string, d: { cols: Col[]; rows: Row[] }) => {
    const ws = wb.addWorksheet(name);
    ws.columns = d.cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16 }));
    d.rows.forEach((r) => ws.addRow(Object.fromEntries(d.cols.map((c) => [c.key, c.money && r[c.key] !== '' && r[c.key] != null ? Number(r[c.key]) : r[c.key]]))));
    d.cols.forEach((c, i) => { if (c.money) ws.getColumn(i + 1).numFmt = '"R$" #,##0.00'; });
    ws.getRow(1).font = { bold: true };
  };
  add('Empréstimos', data.loans);
  add('Pagamentos', data.payments);
  add('Clientes', data.clients);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV no padrão brasileiro (separador ";", vírgula decimal, BOM para abrir corretamente no Excel). */
export async function exportCsv(companyId: string, kind: 'loans' | 'payments' | 'clients') {
  const d = (await exportData(companyId))[kind];
  const cell = (v: unknown, money?: boolean) => {
    if (v == null) return '';
    let s = String(v);
    if (money && s) s = s.replace('.', ',');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [d.cols.map((c) => cell(c.header)).join(';'), ...d.rows.map((r) => d.cols.map((c) => cell(r[c.key], c.money)).join(';'))];
  return '﻿' + lines.join('\r\n');
}

/** Backup completo em JSON (clientes, empréstimos, pagamentos, contratos e configurações). */
export async function backupJson(companyId: string) {
  const [company, clients, loans, payments, contracts, events] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { id: true, name: true, slug: true, settings: true } }),
    prisma.client.findMany({ where: { companyId } }),
    prisma.loan.findMany({ where: { companyId } }),
    prisma.payment.findMany({ where: { companyId } }),
    prisma.contract.findMany({ where: { companyId }, select: { id: true, loanId: true, version: true, kind: true, status: true, renderedContent: true, sha256: true, signedAt: true, createdAt: true } }),
    prisma.loanEvent.findMany({ where: { loan: { companyId } } }),
  ]);
  return {
    format: 'emprestimoshero-backup', version: 1, generatedAt: new Date().toISOString(),
    company: { ...company, settings: readSettings(company.settings) },
    clients, loans, payments, contracts, events,
  };
}
