/**
 * Motor de empréstimos sobre saldo devedor (engine BALANCE).
 *
 * Regras:
 *  - A taxa informada vale exatamente para o período escolhido (diário, semanal, quinzenal ou mensal).
 *  - Os juros de cada período são calculados sobre o saldo devedor (principal em aberto) no início do
 *    período e valem pelo período inteiro, mesmo que o pagamento ocorra antes do vencimento.
 *  - Todo pagamento é abatido nesta ordem: encargos de atraso → juros pendentes → principal.
 *  - Juros não pagos ficam pendentes. Conforme a configuração do empréstimo, no início do período
 *    seguinte eles ficam SEPARADOS (não geram juros) ou são SOMADOS ao principal (CAPITALIZE).
 *  - Tipos de cobrança:
 *      INTEREST_ONLY      juros vencem ao fim de cada período; o principal vence no vencimento final.
 *      FIXED_INSTALLMENTS parcela = juros do período + amortização (Price sobre o saldo e os períodos
 *                         restantes). Pagamentos extras reduzem o valor das próximas parcelas.
 *      SINGLE_PAYMENT     tudo (principal + juros acumulados) vence no vencimento final.
 *  - Após o vencimento final, se ainda houver saldo, os juros continuam correndo a cada período.
 *  - Atraso: multa única (%) sobre cada valor que vence sem pagamento e juros de mora (% ao mês,
 *    proporcionais aos dias) sobre o valor vencido. Os encargos são somados ao saldo.
 *  - Tudo é recalculado do zero a partir dos pagamentos lançados, então editar ou excluir um
 *    pagamento refaz o histórico inteiro.
 *  - Valores arredondados para centavos (HALF_UP) em cada lançamento.
 */
import { Decimal, D, cents, ZERO, max0, sum } from '../lib/money.js';
import { addDays, addMonthsKeepingDay, dateOnly, daysBetween } from '../lib/dates.js';

export type BillingType = 'INTEREST_ONLY' | 'FIXED_INSTALLMENTS' | 'SINGLE_PAYMENT';
export type RatePeriod = 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
export type PendingInterestMode = 'SEPARATE' | 'CAPITALIZE';

export interface BalanceTerms {
  principal: Decimal.Value;
  ratePct: Decimal.Value; // % por período
  ratePeriod: RatePeriod;
  startDate: Date;
  maturityDate: Date;
  billingType: BillingType;
  pendingInterestMode: PendingInterestMode;
  lateFineRate?: Decimal.Value; // % (multa única)
  lateInterestMonthly?: Decimal.Value; // % ao mês, proporcional aos dias
}

export interface LedgerPaymentInput {
  id: string;
  date: Date;
  amount: Decimal.Value;
}

export interface PaymentAllocation {
  id: string;
  date: Date;
  amount: Decimal;
  charges: Decimal;
  interest: Decimal;
  principal: Decimal;
  /** Principal em aberto após o pagamento. */
  principalAfter: Decimal;
  /** Juros pendentes após o pagamento. */
  interestAfter: Decimal;
  /** Encargos de atraso pendentes após o pagamento. */
  chargesAfter: Decimal;
  /** Saldo total (principal + juros pendentes + encargos) após o pagamento. */
  totalAfter: Decimal;
  /** Juros do próximo período calculados sobre o novo saldo. */
  nextPeriodInterest: Decimal;
}

export type PeriodStatus = 'PAID' | 'OVERDUE' | 'DUE_TODAY' | 'UPCOMING' | 'PROJECTED' | 'ACCRUING';

export interface PeriodRow {
  number: number;
  startDate: Date;
  dueDate: Date;
  openingPrincipal: Decimal;
  interest: Decimal;
  principalDue: Decimal;
  amountDue: Decimal;
  /** Quanto deste vencimento ainda está em aberto. */
  remaining: Decimal;
  status: PeriodStatus;
  projected: boolean;
}

export type LoanDisplayStatus = 'ON_TIME' | 'DUE_TODAY' | 'DUE_THIS_WEEK' | 'OVERDUE' | 'PAID';

export interface LedgerResult {
  asOf: Date;
  periodRate: Decimal; // fração
  termPeriods: number;
  principal: Decimal;
  principalOpen: Decimal;
  interestPending: Decimal;
  chargesPending: Decimal;
  balance: Decimal; // principal + juros pendentes + encargos
  interestAccrued: Decimal;
  interestCapitalized: Decimal;
  chargesAccrued: Decimal;
  totalPaid: Decimal;
  principalPaid: Decimal;
  interestPaid: Decimal;
  chargesPaid: Decimal;
  overdueAmount: Decimal;
  daysLate: number;
  /** Juros futuros previstos até o vencimento final, se o cliente pagar em dia. */
  futureInterest: Decimal;
  /** Quanto ainda falta receber até o fim, se o cliente pagar em dia (saldo + juros futuros). */
  totalToReceive: Decimal;
  nextDue: { date: Date; amount: Decimal; number: number } | null;
  /** Juros do próximo período sobre o saldo atual. */
  nextPeriodInterest: Decimal;
  status: LoanDisplayStatus;
  payments: PaymentAllocation[];
  periods: PeriodRow[];
}

export class LedgerError extends Error {}

const MAX_PERIODS = 5000;

/** Fim do k-ésimo período a partir de uma data (k >= 1). */
export function addPeriods(start: Date, k: number, p: RatePeriod): Date {
  const s = dateOnly(start);
  if (p === 'MONTHLY') return addMonthsKeepingDay(s, k);
  const days = { DAILY: 1, WEEKLY: 7, BIWEEKLY: 15 }[p];
  return dateOnly(addDays(s, k * days));
}

/** Quantidade de períodos entre a data do empréstimo e o vencimento (arredonda para cima, mínimo 1). */
export function countPeriods(start: Date, maturity: Date, p: RatePeriod): number {
  if (dateOnly(maturity) <= dateOnly(start)) throw new LedgerError('O vencimento deve ser posterior à data do empréstimo');
  let n = 1;
  while (addPeriods(start, n, p) < dateOnly(maturity)) {
    n++;
    if (n > MAX_PERIODS) throw new LedgerError('Prazo longo demais para o período escolhido');
  }
  return n;
}

/** Vencimento do período k (1-based): fim natural do período, o vencimento final em k = n e, depois dele, períodos a partir do vencimento final. */
function dueDateOf(t: BalanceTerms, n: number, k: number): Date {
  if (k < n) return addPeriods(t.startDate, k, t.ratePeriod);
  if (k === n) return dateOnly(t.maturityDate);
  return addPeriods(t.maturityDate, k - n, t.ratePeriod);
}

/** Amortização programada (Price) do saldo-base em r períodos restantes. */
function priceAmortization(base: Decimal, i: Decimal, r: number): Decimal {
  if (base.lte(0)) return ZERO;
  if (r <= 1) return base;
  if (i.isZero()) return cents(base.div(r));
  const pmt = base.times(i).div(D(1).minus(D(1).plus(i).pow(-r)));
  return Decimal.min(base, cents(pmt.minus(base.times(i))));
}

interface DueBucket { period: number; remaining: Decimal }

/** Estado do razão do empréstimo, avançado evento a evento. */
class Ledger {
  readonly i: Decimal;
  readonly n: number;
  P: Decimal; // principal em aberto
  I = ZERO; // juros pendentes
  C = ZERO; // encargos de atraso pendentes
  DI = ZERO; // juros vencidos e não pagos (contidos em I)
  DP = ZERO; // principal vencido e não pago (contido em P)
  k = 0; // período corrente
  lastLateDate: Date;
  periodPrincipalCredit = ZERO; // principal pago adiantado dentro do período corrente
  scheduledPrincipal = ZERO; // amortização programada do período corrente
  buckets: DueBucket[] = [];
  periods: PeriodRow[] = [];
  interestAccrued = ZERO;
  interestCapitalized = ZERO;
  chargesAccrued = ZERO;
  paid = { total: ZERO, principal: ZERO, interest: ZERO, charges: ZERO };
  allocations: PaymentAllocation[] = [];
  finished = false;
  firstOverdueDate: Date | null = null;

  constructor(readonly t: BalanceTerms) {
    this.i = D(t.ratePct).div(100);
    if (this.i.lt(0)) throw new LedgerError('Taxa inválida');
    this.P = cents(t.principal);
    if (this.P.lte(0)) throw new LedgerError('O valor emprestado deve ser maior que zero');
    this.n = countPeriods(t.startDate, t.maturityDate, t.ratePeriod);
    this.lastLateDate = dateOnly(t.startDate);
  }

  get dueTotal() { return this.DI.plus(this.DP); }
  get balance() { return this.P.plus(this.I).plus(this.C); }
  dueDate(k: number) { return dueDateOf(this.t, this.n, k); }

  /** Inicia o período seguinte: capitaliza juros pendentes (se configurado) e lança os juros do período. */
  startPeriod() {
    if (this.k >= MAX_PERIODS) throw new LedgerError('Limite de períodos excedido');
    const start = this.k === 0 ? dateOnly(this.t.startDate) : this.dueDate(this.k);
    this.k++;
    if (this.t.pendingInterestMode === 'CAPITALIZE' && this.I.gt(0)) {
      this.P = this.P.plus(this.I);
      this.DP = this.DP.plus(this.DI);
      this.interestCapitalized = this.interestCapitalized.plus(this.I);
      this.I = ZERO;
      this.DI = ZERO;
    }
    const interest = cents(this.P.times(this.i));
    this.I = this.I.plus(interest);
    this.interestAccrued = this.interestAccrued.plus(interest);
    this.periodPrincipalCredit = ZERO;
    if (this.k >= this.n) this.scheduledPrincipal = this.P.minus(this.DP);
    else if (this.t.billingType === 'FIXED_INSTALLMENTS') this.scheduledPrincipal = priceAmortization(this.P.minus(this.DP), this.i, this.n - this.k + 1);
    else this.scheduledPrincipal = ZERO;
    const dueAtEnd = this.t.billingType !== 'SINGLE_PAYMENT' || this.k >= this.n;
    const principalDue = dueAtEnd ? this.scheduledPrincipal : ZERO;
    // no pagamento único, o vencimento final cobra todos os juros acumulados
    const interestDue = !dueAtEnd ? ZERO : this.t.billingType === 'SINGLE_PAYMENT' ? this.I.minus(this.DI) : interest;
    this.periods.push({
      number: this.k, startDate: start, dueDate: this.dueDate(this.k), openingPrincipal: this.P, interest,
      principalDue, amountDue: interestDue.plus(principalDue), remaining: ZERO, status: 'UPCOMING', projected: false,
    });
  }

  /** Juros de mora sobre o valor vencido entre a última apuração e a data informada. */
  accrueLate(to: Date) {
    const days = daysBetween(this.lastLateDate, to);
    if (days > 0 && this.dueTotal.gt(0)) {
      const mora = cents(this.dueTotal.times(D(this.t.lateInterestMonthly ?? 0)).div(100).div(30).times(days));
      this.C = this.C.plus(mora);
      this.chargesAccrued = this.chargesAccrued.plus(mora);
    }
    if (to > this.lastLateDate) this.lastLateDate = dateOnly(to);
  }

  /** Quanto passará a estar vencido no fim do período corrente (sem considerar o que já está vencido). */
  newlyDueAtPeriodEnd(): { interest: Decimal; principal: Decimal } {
    const dueAtEnd = this.t.billingType !== 'SINGLE_PAYMENT' || this.k >= this.n;
    if (!dueAtEnd) return { interest: ZERO, principal: ZERO };
    const principal = this.k >= this.n ? this.P.minus(this.DP) : max0(Decimal.min(this.P.minus(this.DP), this.scheduledPrincipal.minus(this.periodPrincipalCredit)));
    return { interest: this.I.minus(this.DI), principal };
  }

  /** Fim do período corrente: os valores programados passam a estar vencidos. */
  closePeriod() {
    const due = this.dueDate(this.k);
    this.accrueLate(due);
    const nd = this.newlyDueAtPeriodEnd();
    const increase = nd.interest.plus(nd.principal);
    this.DI = this.DI.plus(nd.interest);
    this.DP = this.DP.plus(nd.principal);
    if (increase.gt(0)) {
      this.buckets.push({ period: this.k, remaining: increase });
      const fine = cents(increase.times(D(this.t.lateFineRate ?? 0)).div(100));
      if (fine.gt(0)) { this.C = this.C.plus(fine); this.chargesAccrued = this.chargesAccrued.plus(fine); }
      this.firstOverdueDate ??= due;
    }
  }

  /** Aplica um pagamento: encargos → juros → principal. */
  pay(p: LedgerPaymentInput) {
    const date = dateOnly(p.date);
    this.accrueLate(date);
    const amount = cents(p.amount);
    if (amount.lte(0)) throw new LedgerError('O valor do pagamento deve ser maior que zero');
    if (amount.gt(this.balance.plus('0.004'))) throw new LedgerError(`Pagamento de ${amount.toFixed(2)} em ${date.toISOString().slice(0, 10)} é maior que o saldo devedor nessa data (${this.balance.toFixed(2)})`);
    let x = amount;
    const charges = Decimal.min(x, this.C); this.C = this.C.minus(charges); x = x.minus(charges);
    const interest = Decimal.min(x, this.I); this.I = this.I.minus(interest); x = x.minus(interest);
    const principal = Decimal.min(x, this.P); this.P = this.P.minus(principal);
    const dueBefore = this.dueTotal;
    const diPaid = Decimal.min(this.DI, interest); this.DI = this.DI.minus(diPaid);
    const dpPaid = Decimal.min(this.DP, principal); this.DP = this.DP.minus(dpPaid);
    this.periodPrincipalCredit = this.periodPrincipalCredit.plus(principal.minus(dpPaid));
    let reduce = dueBefore.minus(this.dueTotal);
    for (const b of this.buckets) {
      if (reduce.lte(0)) break;
      const r = Decimal.min(reduce, b.remaining);
      b.remaining = b.remaining.minus(r);
      reduce = reduce.minus(r);
    }
    this.buckets = this.buckets.filter((b) => b.remaining.gt(0));
    if (this.dueTotal.isZero()) this.firstOverdueDate = null;
    this.paid.total = this.paid.total.plus(amount);
    this.paid.charges = this.paid.charges.plus(charges);
    this.paid.interest = this.paid.interest.plus(interest);
    this.paid.principal = this.paid.principal.plus(principal);
    const nextBase = this.t.pendingInterestMode === 'CAPITALIZE' ? this.P.plus(this.I) : this.P;
    this.allocations.push({
      id: p.id, date, amount, charges, interest, principal,
      principalAfter: this.P, interestAfter: this.I, chargesAfter: this.C, totalAfter: this.balance,
      nextPeriodInterest: cents(nextBase.times(this.i)),
    });
    if (this.balance.isZero()) this.finished = true;
  }

  /** Situação de cada vencimento já lançado. */
  periodStatuses(asOf: Date) {
    const open = new Map(this.buckets.map((b) => [b.period, b.remaining]));
    for (const row of this.periods) {
      if (this.t.billingType === 'SINGLE_PAYMENT' && row.number < this.n) { row.remaining = ZERO; row.status = 'ACCRUING'; continue; }
      if (row.number < this.k) {
        row.remaining = open.get(row.number) ?? ZERO;
        row.status = row.remaining.gt(0) ? 'OVERDUE' : 'PAID';
      } else if (this.finished) {
        row.remaining = ZERO;
        row.status = 'PAID';
      } else {
        const nd = this.newlyDueAtPeriodEnd();
        row.remaining = nd.interest.plus(nd.principal);
        row.status = row.remaining.isZero() ? 'PAID' : row.dueDate.getTime() === asOf.getTime() ? 'DUE_TODAY' : 'UPCOMING';
      }
    }
  }
}

/** Projeção dos períodos restantes até o vencimento final, supondo pagamento em dia. */
function projectFuture(l: Ledger): { rows: PeriodRow[]; futureInterest: Decimal } {
  const rows: PeriodRow[] = [];
  if (l.finished || l.k >= l.n) return { rows, futureInterest: ZERO };
  const t = l.t;
  // ao fim do período corrente o cliente paga o que vence
  const nd = l.newlyDueAtPeriodEnd();
  let P = l.P.minus(nd.principal);
  let I = l.I.minus(nd.interest);
  let future = ZERO;
  let start = l.dueDate(l.k);
  for (let k = l.k + 1; k <= l.n; k++) {
    if (t.pendingInterestMode === 'CAPITALIZE' && I.gt(0)) { P = P.plus(I); I = ZERO; }
    const interest = cents(P.times(l.i));
    future = future.plus(interest);
    I = I.plus(interest);
    let principalDue = ZERO;
    if (k >= l.n) principalDue = P;
    else if (t.billingType === 'FIXED_INSTALLMENTS') principalDue = priceAmortization(P, l.i, l.n - k + 1);
    const dueAtEnd = t.billingType !== 'SINGLE_PAYMENT' || k >= l.n;
    const interestDue = dueAtEnd ? I : ZERO;
    const due = dueDateOf(t, l.n, k);
    rows.push({ number: k, startDate: start, dueDate: due, openingPrincipal: P, interest, principalDue, amountDue: interestDue.plus(principalDue), remaining: interestDue.plus(principalDue), status: 'PROJECTED', projected: true });
    if (dueAtEnd) { I = ZERO; P = P.minus(principalDue); }
    start = due;
  }
  return { rows, futureInterest: future };
}

/**
 * Reprocessa o empréstimo do início até a data de referência, aplicando os pagamentos em ordem
 * cronológica (a ordem da lista desempata pagamentos no mesmo dia).
 */
export function computeLedger(terms: BalanceTerms, payments: LedgerPaymentInput[], asOfInput: Date): LedgerResult {
  const asOf = dateOnly(asOfInput);
  const l = new Ledger(terms);
  const start = dateOnly(terms.startDate);
  const sorted = payments.map((p, idx) => ({ ...p, date: dateOnly(p.date), idx })).sort((a, b) => a.date.getTime() - b.date.getTime() || a.idx - b.idx);
  for (const p of sorted) {
    if (p.date < start) throw new LedgerError('Pagamento com data anterior à data do empréstimo');
    if (p.date > asOf) throw new LedgerError('Pagamento com data futura');
  }
  l.startPeriod();
  let pi = 0;
  for (;;) {
    const due = l.dueDate(l.k);
    // pagamentos até o vencimento do período (inclusive) contam neste período
    while (pi < sorted.length && sorted[pi].date <= due) {
      if (l.finished) throw new LedgerError('Pagamento lançado após a quitação do empréstimo');
      l.pay(sorted[pi++]);
    }
    if (l.finished || due >= asOf) break;
    l.closePeriod();
    l.startPeriod();
  }
  if (pi < sorted.length) throw new LedgerError('Pagamento fora do período do empréstimo');
  if (!l.finished) l.accrueLate(asOf);
  l.periodStatuses(asOf);

  const proj = projectFuture(l);
  const overdue = l.dueTotal;
  const daysLate = overdue.gt(0) && l.firstOverdueDate ? daysBetween(l.firstOverdueDate, asOf) : 0;
  let nextDue: LedgerResult['nextDue'] = null;
  if (!l.finished) {
    const nd = l.newlyDueAtPeriodEnd();
    const amt = nd.interest.plus(nd.principal);
    if (amt.gt(0)) nextDue = { date: l.dueDate(l.k), amount: amt, number: l.k };
    else {
      const p = proj.rows.find((r) => r.amountDue.gt(0));
      if (p) nextDue = { date: p.dueDate, amount: p.amountDue, number: p.number };
    }
  }
  let status: LoanDisplayStatus = 'ON_TIME';
  if (l.finished) status = 'PAID';
  else if (overdue.gt(0)) status = 'OVERDUE';
  else if (nextDue && nextDue.date.getTime() === asOf.getTime()) status = 'DUE_TODAY';
  else if (nextDue && daysBetween(asOf, nextDue.date) <= 7) status = 'DUE_THIS_WEEK';
  const nextBase = terms.pendingInterestMode === 'CAPITALIZE' ? l.P.plus(l.I) : l.P;
  return {
    asOf,
    periodRate: l.i,
    termPeriods: l.n,
    principal: cents(terms.principal),
    principalOpen: l.P,
    interestPending: l.I,
    chargesPending: l.C,
    balance: l.balance,
    interestAccrued: l.interestAccrued,
    interestCapitalized: l.interestCapitalized,
    chargesAccrued: l.chargesAccrued,
    totalPaid: l.paid.total,
    principalPaid: l.paid.principal,
    interestPaid: l.paid.interest,
    chargesPaid: l.paid.charges,
    overdueAmount: overdue,
    daysLate,
    futureInterest: proj.futureInterest,
    totalToReceive: l.balance.plus(proj.futureInterest),
    nextDue,
    nextPeriodInterest: l.finished ? ZERO : cents(nextBase.times(l.i)),
    status,
    payments: l.allocations,
    periods: [...l.periods, ...proj.rows],
  };
}

/** Simula o empréstimo do início ao fim, supondo que o cliente pague cada vencimento em dia. */
export function simulateBalance(terms: BalanceTerms) {
  const r = computeLedger(terms, [], terms.startDate);
  const totalInterest = sum(r.periods.map((p) => p.interest));
  const principal = cents(terms.principal);
  return {
    termPeriods: r.termPeriods,
    periodRate: r.periodRate,
    principal,
    totalInterest,
    totalToReceive: principal.plus(totalInterest),
    profit: totalInterest,
    firstInstallment: r.periods[0]?.amountDue ?? ZERO,
    periods: r.periods,
  };
}

/** Taxa mensal equivalente (composta) de uma taxa por período, em %. */
export function monthlyEquivalent(ratePct: Decimal.Value, p: RatePeriod): Decimal {
  if (p === 'MONTHLY') return D(ratePct);
  const days = { DAILY: 1, WEEKLY: 7, BIWEEKLY: 15 }[p];
  return D(1).plus(D(ratePct).div(100)).pow(D(30).div(days)).minus(1).times(100);
}

export const serializeDec = (d: Decimal) => d.toFixed(2);

export function serializeLedger(r: LedgerResult) {
  const s = serializeDec;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    asOf: iso(r.asOf),
    periodRate: r.periodRate.times(100).toDecimalPlaces(6).toString(),
    termPeriods: r.termPeriods,
    principal: s(r.principal),
    principalOpen: s(r.principalOpen),
    interestPending: s(r.interestPending),
    chargesPending: s(r.chargesPending),
    balance: s(r.balance),
    interestAccrued: s(r.interestAccrued),
    interestCapitalized: s(r.interestCapitalized),
    chargesAccrued: s(r.chargesAccrued),
    totalPaid: s(r.totalPaid),
    principalPaid: s(r.principalPaid),
    interestPaid: s(r.interestPaid),
    chargesPaid: s(r.chargesPaid),
    overdueAmount: s(r.overdueAmount),
    daysLate: r.daysLate,
    futureInterest: s(r.futureInterest),
    totalToReceive: s(r.totalToReceive),
    nextDue: r.nextDue ? { date: iso(r.nextDue.date), amount: s(r.nextDue.amount), number: r.nextDue.number } : null,
    nextPeriodInterest: s(r.nextPeriodInterest),
    status: r.status,
    progress: r.principal.plus(r.interestAccrued).plus(r.chargesAccrued).isZero() ? 0 : Number(r.totalPaid.div(r.totalPaid.plus(r.totalToReceive)).times(100).toDecimalPlaces(1)),
    payments: r.payments.map((p) => ({ id: p.id, date: iso(p.date), amount: s(p.amount), charges: s(p.charges), interest: s(p.interest), principal: s(p.principal), principalAfter: s(p.principalAfter), interestAfter: s(p.interestAfter), chargesAfter: s(p.chargesAfter), totalAfter: s(p.totalAfter), nextPeriodInterest: s(p.nextPeriodInterest) })),
    periods: r.periods.map((p) => ({ number: p.number, startDate: iso(p.startDate), dueDate: iso(p.dueDate), openingPrincipal: s(p.openingPrincipal), interest: s(p.interest), principalDue: s(p.principalDue), amountDue: s(p.amountDue), remaining: s(p.remaining), status: p.status, projected: p.projected })),
  };
}
