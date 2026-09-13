/**
 * Regras de saldo de parcela, encargos de atraso e alocação de pagamentos.
 *
 *  - Base em aberto = principal + juros da parcela − principal pago − juros pagos.
 *  - Multa: percentual único sobre a base em aberto no primeiro dia de atraso (aplicada uma vez;
 *    após um pagamento em atraso a multa fica marcada como aplicada).
 *  - Mora: taxa mensal / 30 por dia, sobre a base em aberto, contada desde o vencimento ou desde o
 *    último pagamento (o que for mais recente). Encargos apurados e não pagos ficam "carregados".
 *  - Alocação de um recebimento: encargos → juros → principal. Desconto reduz na mesma ordem.
 */
import { Decimal, D, cents, ZERO, max0 } from '../lib/money.js';
import { daysBetween, dateOnly } from '../lib/dates.js';

export interface InstallmentLike {
  dueDate: Date;
  principalAmount: Decimal.Value;
  interestAmount: Decimal.Value;
  originalAmount: Decimal.Value;
  status: 'PENDING' | 'PARTIAL' | 'PAID' | 'RENEGOTIATED' | 'CANCELLED';
  paidPrincipal: Decimal.Value;
  paidInterest: Decimal.Value;
  paidCharges: Decimal.Value;
  discountAmount: Decimal.Value;
  chargesCarried: Decimal.Value;
  fineApplied: boolean;
  lastPaymentAt: Date | null;
}

export interface LoanChargeRules {
  lateFineRate: Decimal.Value; // %
  lateInterestMonthly: Decimal.Value; // % ao mês
}

export interface InstallmentBalance {
  principalOpen: Decimal;
  interestOpen: Decimal;
  openBase: Decimal;
  daysLate: number;
  fine: Decimal;
  lateInterest: Decimal;
  chargesCarried: Decimal;
  chargesDue: Decimal;
  totalDue: Decimal;
  displayStatus: 'UPCOMING' | 'DUE_TODAY' | 'OVERDUE' | 'PARTIAL' | 'PAID' | 'RENEGOTIATED' | 'CANCELLED';
}

export function computeBalance(inst: InstallmentLike, rules: LoanChargeRules, asOf: Date): InstallmentBalance {
  const today = dateOnly(asOf);
  const due = dateOnly(inst.dueDate);
  const principalOpen = max0(D(inst.principalAmount).minus(inst.paidPrincipal));
  const interestOpen = max0(D(inst.interestAmount).minus(inst.paidInterest));
  const openBase = principalOpen.plus(interestOpen);
  const closed = inst.status === 'PAID' || inst.status === 'RENEGOTIATED' || inst.status === 'CANCELLED';
  const daysLate = closed ? 0 : Math.max(0, daysBetween(due, today));
  let fine = ZERO;
  let lateInterest = ZERO;
  if (!closed && daysLate > 0 && openBase.gt(0)) {
    if (!inst.fineApplied) fine = cents(openBase.times(D(rules.lateFineRate)).div(100));
    const start = inst.lastPaymentAt && dateOnly(inst.lastPaymentAt) > due ? dateOnly(inst.lastPaymentAt) : due;
    const days = Math.max(0, daysBetween(start, today));
    lateInterest = cents(openBase.times(D(rules.lateInterestMonthly)).div(100).div(30).times(days));
  }
  const chargesCarried = closed ? ZERO : D(inst.chargesCarried);
  const chargesDue = chargesCarried.plus(fine).plus(lateInterest);
  const totalDue = closed ? ZERO : openBase.plus(chargesDue);
  let displayStatus: InstallmentBalance['displayStatus'];
  if (inst.status === 'PAID') displayStatus = 'PAID';
  else if (inst.status === 'RENEGOTIATED') displayStatus = 'RENEGOTIATED';
  else if (inst.status === 'CANCELLED') displayStatus = 'CANCELLED';
  else if (daysLate > 0) displayStatus = 'OVERDUE';
  else if (inst.status === 'PARTIAL') displayStatus = 'PARTIAL';
  else if (due.getTime() === today.getTime()) displayStatus = 'DUE_TODAY';
  else displayStatus = 'UPCOMING';
  if (displayStatus === 'OVERDUE' && inst.status === 'PARTIAL') displayStatus = 'OVERDUE';
  return { principalOpen, interestOpen, openBase, daysLate, fine, lateInterest, chargesCarried, chargesDue, totalDue, displayStatus };
}

export interface Allocation {
  chargesPortion: Decimal;
  interestPortion: Decimal;
  principalPortion: Decimal;
  discountCharges: Decimal;
  discountInterest: Decimal;
  discountPrincipal: Decimal;
  remainingAfter: Decimal;
}

/** Aloca um valor pago (e um desconto) sobre o saldo, na ordem encargos → juros → principal. */
export function allocatePayment(balance: InstallmentBalance, amount: Decimal.Value, discount: Decimal.Value = 0): Allocation {
  const amt = cents(amount);
  const disc = cents(discount);
  if (amt.lt(0) || disc.lt(0)) throw new Error('Valores negativos não são permitidos');
  if (amt.plus(disc).gt(balance.totalDue.plus('0.005'))) throw new Error('Valor pago mais desconto excede o saldo da parcela');
  // desconto primeiro
  let d = disc;
  const discountCharges = Decimal.min(d, balance.chargesDue); d = d.minus(discountCharges);
  const discountInterest = Decimal.min(d, balance.interestOpen); d = d.minus(discountInterest);
  const discountPrincipal = Decimal.min(d, balance.principalOpen);
  let a = amt;
  const chargesPortion = Decimal.min(a, balance.chargesDue.minus(discountCharges)); a = a.minus(chargesPortion);
  const interestPortion = Decimal.min(a, balance.interestOpen.minus(discountInterest)); a = a.minus(interestPortion);
  const principalPortion = Decimal.min(a, balance.principalOpen.minus(discountPrincipal));
  const remainingAfter = balance.totalDue.minus(amt).minus(disc);
  return { chargesPortion, interestPortion, principalPortion, discountCharges, discountInterest, discountPrincipal, remainingAfter: max0(remainingAfter) };
}

/**
 * Quitação antecipada de uma parcela ainda não vencida: cobra o principal integral e os juros
 * proporcionais aos dias decorridos do período (pro rata), dispensando o restante dos juros.
 */
export function earlyPayoffAmount(inst: InstallmentLike, rules: LoanChargeRules, asOf: Date, periodDaysCount: number): { principal: Decimal; interest: Decimal; charges: Decimal; waivedInterest: Decimal; total: Decimal } {
  const b = computeBalance(inst, rules, asOf);
  if (b.daysLate > 0 || b.displayStatus === 'DUE_TODAY') {
    return { principal: b.principalOpen, interest: b.interestOpen, charges: b.chargesDue, waivedInterest: ZERO, total: b.totalDue };
  }
  const due = dateOnly(inst.dueDate);
  const daysToDue = daysBetween(dateOnly(asOf), due);
  const elapsed = Math.max(0, periodDaysCount - daysToDue);
  const proRata = cents(b.interestOpen.times(Math.min(elapsed, periodDaysCount)).div(periodDaysCount));
  return { principal: b.principalOpen, interest: proRata, charges: ZERO, waivedInterest: b.interestOpen.minus(proRata), total: b.principalOpen.plus(proRata) };
}
