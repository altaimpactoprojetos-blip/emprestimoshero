/**
 * Motor de cálculo financeiro.
 *
 * Regras (documentadas e aplicadas igualmente em simulação, contrato, parcelas e relatórios):
 *  - Cálculo decimal (decimal.js) com 30 dígitos de precisão nas etapas intermediárias.
 *  - Arredondamento HALF_UP para centavos apenas nos valores apresentados/gravados.
 *  - A última parcela absorve o resíduo de arredondamento, de modo que a soma das amortizações
 *    seja exatamente igual ao principal financiado ("HALF_UP_2_LAST_ADJUST").
 *  - Taxa por período: taxa mensal informada; para periodicidades diferentes de mensal usa-se a
 *    taxa equivalente composta i_p = (1 + i_m)^(dias/30) - 1 (quinzenal 15, semanal 7, diária 1).
 *  - Juros por período nominal, independentemente do intervalo entre liberação e 1º vencimento;
 *    o efeito do prazo real aparece no CET, calculado por fluxo de caixa com datas efetivas.
 *  - IOF: alíquota fixa sobre o principal + alíquota diária sobre cada amortização pelo número de
 *    dias até o vencimento (limitado a 365 dias). Alíquotas configuráveis por produto (podem ser zero).
 *  - Tarifa de abertura: valor fixo + percentual sobre o valor solicitado.
 *  - Encargos (tarifa + IOF) podem ser DESCONTADOS do valor liberado ou FINANCIADOS (somados ao principal).
 *  - CET: taxa interna de retorno do fluxo (valor liberado vs. parcelas), base 30 dias, anualizada por (1+r)^12-1.
 */
import { Decimal, D, cents, rate6, sum, ZERO } from '../lib/money.js';
import { daysBetween, nthDueDate, periodDays } from '../lib/dates.js';
import type { CalcMethod, ChargeMode, Periodicity } from '@prisma/client';

export interface SimulationInput {
  requestedAmount: Decimal.Value;
  installmentsCount: number;
  periodicity: Periodicity;
  disbursementDate: Date;
  firstDueDate: Date;
  calcMethod: CalcMethod;
  monthlyRate: Decimal.Value; // % ao mês
  chargeMode: ChargeMode;
  originationFee?: Decimal.Value; // R$
  originationFeeRate?: Decimal.Value; // %
  iofFixedRate?: Decimal.Value; // %
  iofDailyRate?: Decimal.Value; // % ao dia
}

export interface ScheduleRow {
  number: number;
  dueDate: Date;
  days: number;
  principal: Decimal;
  interest: Decimal;
  amount: Decimal;
  balanceAfter: Decimal;
}

export interface SimulationResult {
  requestedAmount: Decimal;
  principalAmount: Decimal;
  disbursedAmount: Decimal;
  originationFee: Decimal;
  iofAmount: Decimal;
  totalCharges: Decimal;
  schedule: ScheduleRow[];
  installmentAmount: Decimal;
  totalAmount: Decimal;
  totalInterest: Decimal;
  monthlyRate: Decimal;
  periodRate: Decimal;
  effectiveMonthlyRate: Decimal;
  effectiveAnnualRate: Decimal;
  cetMonthly: Decimal;
  cetAnnual: Decimal;
  roundingRule: string;
  explanation: string;
}

export const ROUNDING_RULE = 'HALF_UP_2_LAST_ADJUST';

export function periodRate(monthlyRatePct: Decimal.Value, p: Periodicity): Decimal {
  const im = D(monthlyRatePct).div(100);
  if (p === 'MONTHLY') return im;
  const days = periodDays(p);
  return D(1).plus(im).pow(D(days).div(30)).minus(1);
}

/** Gera o cronograma de amortização para o principal informado. */
export function buildSchedule(principal: Decimal, n: number, i: Decimal, method: CalcMethod, disbursementDate: Date, firstDueDate: Date, p: Periodicity): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let balance = principal;
  if (method === 'PRICE') {
    const pmt = i.isZero() ? principal.div(n) : principal.times(i).div(D(1).minus(D(1).plus(i).pow(-n)));
    const pmtC = cents(pmt);
    for (let k = 1; k <= n; k++) {
      const interest = cents(balance.times(i));
      let princ = k === n ? balance : cents(pmtC.minus(interest));
      if (princ.gt(balance)) princ = balance;
      const amount = princ.plus(interest);
      balance = balance.minus(princ);
      rows.push({ number: k, dueDate: nthDueDate(firstDueDate, k, p), days: 0, principal: princ, interest, amount, balanceAfter: balance });
    }
  } else if (method === 'SAC') {
    const amort = cents(principal.div(n));
    for (let k = 1; k <= n; k++) {
      const interest = cents(balance.times(i));
      const princ = k === n ? balance : amort;
      balance = balance.minus(princ);
      rows.push({ number: k, dueDate: nthDueDate(firstDueDate, k, p), days: 0, principal: princ, interest, amount: princ.plus(interest), balanceAfter: balance });
    }
  } else {
    // SIMPLE: juros simples sobre o principal pelo número de períodos, distribuídos igualmente
    const totalInterest = cents(principal.times(i).times(n));
    const interestEach = cents(totalInterest.div(n));
    const amortEach = cents(principal.div(n));
    let interestLeft = totalInterest;
    for (let k = 1; k <= n; k++) {
      const interest = k === n ? interestLeft : interestEach;
      const princ = k === n ? balance : amortEach;
      interestLeft = interestLeft.minus(interest);
      balance = balance.minus(princ);
      rows.push({ number: k, dueDate: nthDueDate(firstDueDate, k, p), days: 0, principal: princ, interest, amount: princ.plus(interest), balanceAfter: balance });
    }
  }
  for (const r of rows) r.days = daysBetween(disbursementDate, r.dueDate);
  return rows;
}

function computeIof(principal: Decimal, schedule: ScheduleRow[], fixedPct: Decimal, dailyPct: Decimal): Decimal {
  if (fixedPct.isZero() && dailyPct.isZero()) return ZERO;
  const fixed = principal.times(fixedPct).div(100);
  const daily = sum(schedule.map((r) => r.principal.times(dailyPct).div(100).times(Math.min(Math.max(r.days, 0), 365))));
  return cents(fixed.plus(daily));
}

/** Taxa interna de retorno (base 30 dias) por bissecção; robusta para fluxos convencionais. */
export function irr30(disbursed: Decimal, flows: Array<{ days: number; amount: Decimal }>): Decimal {
  const npv = (r: Decimal) => sum(flows.map((f) => f.amount.div(D(1).plus(r).pow(D(f.days).div(30))))).minus(disbursed);
  let lo = D(0), hi = D(5);
  if (npv(lo).lte(0)) return ZERO;
  for (let it = 0; it < 200; it++) {
    const mid = lo.plus(hi).div(2);
    if (npv(mid).gt(0)) lo = mid; else hi = mid;
    if (hi.minus(lo).lt('1e-12')) break;
  }
  return lo.plus(hi).div(2);
}

export function simulate(input: SimulationInput): SimulationResult {
  const n = input.installmentsCount;
  if (!Number.isInteger(n) || n < 1 || n > 360) throw new Error('Quantidade de parcelas inválida');
  const requested = cents(input.requestedAmount);
  if (requested.lte(0)) throw new Error('Valor solicitado deve ser maior que zero');
  if (input.firstDueDate <= input.disbursementDate) throw new Error('O primeiro vencimento deve ser posterior à data de liberação');
  const monthly = D(input.monthlyRate);
  if (monthly.lt(0)) throw new Error('Taxa inválida');
  const i = periodRate(monthly, input.periodicity);
  const fee = cents(D(input.originationFee ?? 0).plus(requested.times(D(input.originationFeeRate ?? 0)).div(100)));
  const iofFixed = D(input.iofFixedRate ?? 0);
  const iofDaily = D(input.iofDailyRate ?? 0);

  let principal = requested;
  let iof = ZERO;
  let schedule: ScheduleRow[] = [];
  // No modo FINANCIADO o IOF incide também sobre si mesmo: itera até estabilizar em centavos.
  for (let iter = 0; iter < 10; iter++) {
    schedule = buildSchedule(principal, n, i, input.calcMethod, input.disbursementDate, input.firstDueDate, input.periodicity);
    const newIof = computeIof(principal, schedule, iofFixed, iofDaily);
    const newPrincipal = input.chargeMode === 'FINANCED' ? requested.plus(fee).plus(newIof) : requested;
    if (newIof.eq(iof) && newPrincipal.eq(principal)) break;
    iof = newIof;
    principal = newPrincipal;
  }
  schedule = buildSchedule(principal, n, i, input.calcMethod, input.disbursementDate, input.firstDueDate, input.periodicity);
  iof = computeIof(principal, schedule, iofFixed, iofDaily);
  const totalCharges = fee.plus(iof);
  const disbursed = input.chargeMode === 'FINANCED' ? requested : requested.minus(totalCharges);
  if (disbursed.lte(0)) throw new Error('Encargos superam o valor solicitado');

  const totalAmount = sum(schedule.map((r) => r.amount));
  const totalInterest = sum(schedule.map((r) => r.interest));
  const cet = irr30(disbursed, schedule.map((r) => ({ days: r.days, amount: r.amount })));
  const effAnnual = D(1).plus(monthly.div(100)).pow(12).minus(1);

  const methodText: Record<CalcMethod, string> = {
    PRICE: 'Tabela Price: parcelas iguais; juros calculados sobre o saldo devedor a cada período e amortização crescente.',
    SAC: 'SAC: amortização constante do principal; juros sobre o saldo devedor, gerando parcelas decrescentes.',
    SIMPLE: 'Juros simples: juros = principal × taxa do período × número de parcelas, distribuídos igualmente entre as parcelas, com amortização constante.',
  };
  const explanation = [
    methodText[input.calcMethod],
    `Taxa informada: ${monthly.toFixed(4)}% ao mês${input.periodicity !== 'MONTHLY' ? ` (equivalente de ${rate6(i.times(100)).toFixed(4)}% por período ${input.periodicity === 'BIWEEKLY' ? 'quinzenal' : input.periodicity === 'WEEKLY' ? 'semanal' : 'diário'}, pela fórmula (1+i)^(dias/30)-1)` : ''}.`,
    `Encargos: tarifa ${fee.toFixed(2)} + IOF ${iof.toFixed(2)} = ${totalCharges.toFixed(2)}, ${input.chargeMode === 'FINANCED' ? 'financiados junto ao principal' : 'descontados do valor liberado'}.`,
    `CET calculado pela taxa interna de retorno do fluxo (valor liberado ${disbursed.toFixed(2)} contra as parcelas nas datas de vencimento), base 30 dias, anualizada por (1+r)^12-1.`,
    'Arredondamento HALF_UP para centavos; a última parcela ajusta o resíduo para que a soma das amortizações seja igual ao principal.',
  ].join(' ');

  return {
    requestedAmount: requested,
    principalAmount: principal,
    disbursedAmount: disbursed,
    originationFee: fee,
    iofAmount: iof,
    totalCharges,
    schedule,
    installmentAmount: schedule[0].amount,
    totalAmount,
    totalInterest,
    monthlyRate: rate6(monthly),
    periodRate: rate6(i.times(100)),
    effectiveMonthlyRate: rate6(monthly),
    effectiveAnnualRate: rate6(effAnnual.times(100)),
    cetMonthly: rate6(cet.times(100)),
    cetAnnual: rate6(D(1).plus(cet).pow(12).minus(1).times(100)),
    roundingRule: ROUNDING_RULE,
    explanation,
  };
}

export function serializeSimulation(s: SimulationResult) {
  const num = (d: Decimal) => d.toFixed(Math.min(6, d.decimalPlaces() > 2 ? 6 : 2));
  return {
    requestedAmount: s.requestedAmount.toFixed(2),
    principalAmount: s.principalAmount.toFixed(2),
    disbursedAmount: s.disbursedAmount.toFixed(2),
    originationFee: s.originationFee.toFixed(2),
    iofAmount: s.iofAmount.toFixed(2),
    totalCharges: s.totalCharges.toFixed(2),
    installmentAmount: s.installmentAmount.toFixed(2),
    totalAmount: s.totalAmount.toFixed(2),
    totalInterest: s.totalInterest.toFixed(2),
    monthlyRate: num(s.monthlyRate),
    periodRate: num(s.periodRate),
    effectiveMonthlyRate: num(s.effectiveMonthlyRate),
    effectiveAnnualRate: num(s.effectiveAnnualRate),
    cetMonthly: num(s.cetMonthly),
    cetAnnual: num(s.cetAnnual),
    roundingRule: s.roundingRule,
    explanation: s.explanation,
    schedule: s.schedule.map((r) => ({ number: r.number, dueDate: r.dueDate.toISOString().slice(0, 10), days: r.days, principal: r.principal.toFixed(2), interest: r.interest.toFixed(2), amount: r.amount.toFixed(2), balanceAfter: r.balanceAfter.toFixed(2) })),
  };
}
