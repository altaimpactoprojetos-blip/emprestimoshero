import { describe, it, expect } from 'vitest';
import { simulate, periodRate } from '../src/domain/finance.js';
import { computeBalance, allocatePayment, earlyPayoffAmount } from '../src/domain/installment.js';
import { D, sum } from '../src/lib/money.js';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const base = { requestedAmount: 1000, installmentsCount: 3, periodicity: 'MONTHLY' as const, disbursementDate: d('2026-01-10'), firstDueDate: d('2026-02-10'), monthlyRate: 5, chargeMode: 'DEDUCTED' as const };

describe('motor financeiro', () => {
  it('Price: parcela fixa conhecida e soma das amortizações igual ao principal', () => {
    const s = simulate({ ...base, calcMethod: 'PRICE' });
    expect(s.installmentAmount.toFixed(2)).toBe('367.21');
    expect(sum(s.schedule.map((r) => r.principal)).toFixed(2)).toBe('1000.00');
    expect(s.schedule[2].balanceAfter.toFixed(2)).toBe('0.00');
    expect(s.totalAmount.toFixed(2)).toBe(sum(s.schedule.map((r) => r.amount)).toFixed(2));
    expect(s.totalInterest.plus(s.principalAmount).toFixed(2)).toBe(s.totalAmount.toFixed(2));
    // sem encargos, CET mensal fica próximo da taxa (diferença só pelo calendário real)
    expect(Math.abs(s.cetMonthly.toNumber() - 5)).toBeLessThan(0.2);
  });

  it('SAC: amortização constante e parcelas decrescentes', () => {
    const s = simulate({ ...base, calcMethod: 'SAC', requestedAmount: 900 });
    expect(s.schedule.map((r) => r.principal.toFixed(2))).toEqual(['300.00', '300.00', '300.00']);
    expect(s.schedule[0].amount.gt(s.schedule[1].amount)).toBe(true);
    expect(s.schedule[0].interest.toFixed(2)).toBe('45.00');
  });

  it('Juros simples: juros = P × i × n distribuídos', () => {
    const s = simulate({ ...base, calcMethod: 'SIMPLE' });
    expect(s.totalInterest.toFixed(2)).toBe('150.00');
    expect(s.schedule.every((r) => r.interest.toFixed(2) === '50.00')).toBe(true);
    expect(sum(s.schedule.map((r) => r.principal)).toFixed(2)).toBe('1000.00');
  });

  it('resíduo de arredondamento vai para a última parcela', () => {
    const s = simulate({ ...base, calcMethod: 'PRICE', requestedAmount: 1000, installmentsCount: 7, monthlyRate: 3.33 });
    expect(sum(s.schedule.map((r) => r.principal)).toFixed(2)).toBe('1000.00');
    expect(s.schedule.at(-1)!.balanceAfter.isZero()).toBe(true);
  });

  it('encargos descontados reduzem o liberado; financiados aumentam o principal; CET sobe', () => {
    const noFee = simulate({ ...base, calcMethod: 'PRICE' });
    const ded = simulate({ ...base, calcMethod: 'PRICE', originationFee: 50, iofFixedRate: 0.38, iofDailyRate: 0.0082 });
    const fin = simulate({ ...base, calcMethod: 'PRICE', chargeMode: 'FINANCED', originationFee: 50, iofFixedRate: 0.38, iofDailyRate: 0.0082 });
    expect(ded.principalAmount.toFixed(2)).toBe('1000.00');
    expect(ded.disbursedAmount.toFixed(2)).toBe(D(1000).minus(ded.totalCharges).toFixed(2));
    expect(fin.disbursedAmount.toFixed(2)).toBe('1000.00');
    expect(fin.principalAmount.toFixed(2)).toBe(D(1000).plus(fin.totalCharges).toFixed(2));
    expect(ded.cetMonthly.gt(noFee.cetMonthly)).toBe(true);
    expect(fin.cetMonthly.gt(noFee.cetMonthly)).toBe(true);
    expect(ded.iofAmount.gt(0)).toBe(true);
  });

  it('periodicidade quinzenal usa taxa equivalente', () => {
    expect(periodRate(5, 'BIWEEKLY').toFixed(6)).toBe(D(1.05).pow(0.5).minus(1).toFixed(6));
    const s = simulate({ ...base, calcMethod: 'PRICE', periodicity: 'WEEKLY', installmentsCount: 4, firstDueDate: d('2026-01-17') });
    expect(s.schedule[1].dueDate.toISOString().slice(0, 10)).toBe('2026-01-24');
  });

  it('vencimentos mensais mantêm o dia e tratam fim de mês', () => {
    const s = simulate({ ...base, calcMethod: 'PRICE', disbursementDate: d('2026-01-05'), firstDueDate: d('2026-01-31'), installmentsCount: 3 });
    expect(s.schedule.map((r) => r.dueDate.toISOString().slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('rejeita entradas inválidas', () => {
    expect(() => simulate({ ...base, calcMethod: 'PRICE', requestedAmount: 0 })).toThrow();
    expect(() => simulate({ ...base, calcMethod: 'PRICE', firstDueDate: d('2026-01-01') })).toThrow();
    expect(() => simulate({ ...base, calcMethod: 'PRICE', originationFee: 2000 })).toThrow();
  });
});

describe('saldo de parcela e alocação', () => {
  const inst = { dueDate: d('2026-03-10'), principalAmount: 300, interestAmount: 50, originalAmount: 350, status: 'PENDING' as const, paidPrincipal: 0, paidInterest: 0, paidCharges: 0, discountAmount: 0, chargesCarried: 0, fineApplied: false, lastPaymentAt: null };
  const rules = { lateFineRate: 2, lateInterestMonthly: 1 };

  it('antes do vencimento não há encargos', () => {
    const b = computeBalance(inst, rules, d('2026-03-01'));
    expect(b.totalDue.toFixed(2)).toBe('350.00');
    expect(b.displayStatus).toBe('UPCOMING');
    expect(computeBalance(inst, rules, d('2026-03-10')).displayStatus).toBe('DUE_TODAY');
  });

  it('em atraso aplica multa única e mora diária', () => {
    const b = computeBalance(inst, rules, d('2026-03-20'));
    expect(b.daysLate).toBe(10);
    expect(b.fine.toFixed(2)).toBe('7.00'); // 2% de 350
    expect(b.lateInterest.toFixed(2)).toBe('1.17'); // 350 * 1%/30 * 10
    expect(b.totalDue.toFixed(2)).toBe('358.17');
    expect(b.displayStatus).toBe('OVERDUE');
  });

  it('aloca encargos → juros → principal e não permite exceder o saldo', () => {
    const b = computeBalance(inst, rules, d('2026-03-20'));
    const a = allocatePayment(b, 100);
    expect(a.chargesPortion.toFixed(2)).toBe('8.17');
    expect(a.interestPortion.toFixed(2)).toBe('50.00');
    expect(a.principalPortion.toFixed(2)).toBe('41.83');
    expect(a.remainingAfter.toFixed(2)).toBe('258.17');
    expect(() => allocatePayment(b, 400)).toThrow();
    const withDiscount = allocatePayment(b, 350, 8.17);
    expect(withDiscount.discountCharges.toFixed(2)).toBe('8.17');
    expect(withDiscount.remainingAfter.toFixed(2)).toBe('0.00');
  });

  it('após pagamento parcial em atraso, multa não repete e mora recomeça da data do pagamento', () => {
    const partial = { ...inst, status: 'PARTIAL' as const, paidPrincipal: 41.83, paidInterest: 50, paidCharges: 8.17, fineApplied: true, lastPaymentAt: d('2026-03-20') };
    const b = computeBalance(partial, rules, d('2026-03-30'));
    expect(b.openBase.toFixed(2)).toBe('258.17');
    expect(b.fine.toFixed(2)).toBe('0.00');
    expect(b.lateInterest.toFixed(2)).toBe('0.86'); // 258.17 * 1%/30 * 10
  });

  it('quitação antecipada cobra juros pro rata', () => {
    const p = earlyPayoffAmount(inst, rules, d('2026-02-23'), 30); // 15 dias antes do vencimento => 15 dias decorridos
    expect(p.principal.toFixed(2)).toBe('300.00');
    expect(p.interest.toFixed(2)).toBe('25.00');
    expect(p.waivedInterest.toFixed(2)).toBe('25.00');
    const overdue = earlyPayoffAmount(inst, rules, d('2026-03-20'), 30);
    expect(overdue.total.toFixed(2)).toBe('358.17');
  });
});
