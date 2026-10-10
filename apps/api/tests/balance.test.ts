import { describe, expect, it } from 'vitest';
import { computeLedger, simulateBalance, countPeriods, type BalanceTerms } from '../src/domain/balance.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const base: BalanceTerms = {
  principal: 1000,
  ratePct: 10,
  ratePeriod: 'MONTHLY',
  startDate: d('2026-01-10'),
  maturityDate: d('2026-06-10'),
  billingType: 'INTEREST_ONLY',
  pendingInterestMode: 'SEPARATE',
  lateFineRate: 0,
  lateInterestMonthly: 0,
};

describe('empréstimo sobre saldo devedor — pagamento parcial', () => {
  it('exemplo do enunciado: R$ 1.000 a 10% a.m., paga R$ 400 → R$ 100 juros, R$ 300 principal, saldo R$ 700, próximos juros R$ 70', () => {
    const r = computeLedger(base, [{ id: 'p1', date: d('2026-01-25'), amount: 400 }], d('2026-01-25'));
    const p = r.payments[0];
    expect(p.interest.toFixed(2)).toBe('100.00');
    expect(p.principal.toFixed(2)).toBe('300.00');
    expect(p.principalAfter.toFixed(2)).toBe('700.00');
    expect(p.nextPeriodInterest.toFixed(2)).toBe('70.00');
    expect(r.principalOpen.toFixed(2)).toBe('700.00');
    // no mês seguinte os juros incidem sobre o novo saldo
    const next = computeLedger(base, [{ id: 'p1', date: d('2026-01-25'), amount: 400 }], d('2026-02-15'));
    expect(next.periods[1].interest.toFixed(2)).toBe('70.00');
    expect(next.interestPending.toFixed(2)).toBe('70.00');
    expect(next.balance.toFixed(2)).toBe('770.00');
    expect(next.status).toBe('ON_TIME');
  });

  it('pagamento menor que os juros: diferença fica pendente e separada (não gera juros)', () => {
    const r = computeLedger(base, [{ id: 'p1', date: d('2026-01-25'), amount: 60 }], d('2026-02-15'));
    expect(r.payments[0].interest.toFixed(2)).toBe('60.00');
    expect(r.payments[0].principal.toFixed(2)).toBe('0.00');
    expect(r.payments[0].interestAfter.toFixed(2)).toBe('40.00');
    expect(r.periods[1].interest.toFixed(2)).toBe('100.00');
    expect(r.interestPending.toFixed(2)).toBe('140.00');
    expect(r.principalOpen.toFixed(2)).toBe('1000.00');
    expect(r.status).toBe('OVERDUE');
    expect(r.overdueAmount.toFixed(2)).toBe('40.00');
  });

  it('pagamento menor que os juros: diferença somada ao principal (capitalização)', () => {
    const r = computeLedger({ ...base, pendingInterestMode: 'CAPITALIZE' }, [{ id: 'p1', date: d('2026-01-25'), amount: 60 }], d('2026-02-15'));
    expect(r.principalOpen.toFixed(2)).toBe('1040.00');
    expect(r.periods[1].interest.toFixed(2)).toBe('104.00');
    expect(r.interestPending.toFixed(2)).toBe('104.00');
    expect(r.interestCapitalized.toFixed(2)).toBe('40.00');
    expect(r.overdueAmount.toFixed(2)).toBe('40.00'); // continua vencido, agora como principal
  });

  it('próximo pagamento quita primeiro os juros antigos, depois os do mês e só então o principal', () => {
    const pays = [{ id: 'p1', date: d('2026-01-25'), amount: 60 }, { id: 'p2', date: d('2026-02-20'), amount: 340 }];
    const r = computeLedger(base, pays, d('2026-02-20'));
    expect(r.payments[1].interest.toFixed(2)).toBe('140.00');
    expect(r.payments[1].principal.toFixed(2)).toBe('200.00');
    expect(r.principalOpen.toFixed(2)).toBe('800.00');
    expect(r.status).toBe('ON_TIME');
  });

  it('pagamento no próprio vencimento conta no período que vence', () => {
    const r = computeLedger(base, [{ id: 'p1', date: d('2026-02-10'), amount: 1100 }], d('2026-02-10'));
    expect(r.status).toBe('PAID');
    expect(r.balance.toFixed(2)).toBe('0.00');
  });

  it('rejeita pagamento maior que o saldo', () => {
    expect(() => computeLedger(base, [{ id: 'p1', date: d('2026-01-25'), amount: 1100.01 }], d('2026-01-25'))).toThrow(/maior que o saldo/);
  });

  it('excluir/editar um pagamento refaz todo o histórico', () => {
    const pays = [{ id: 'p1', date: d('2026-01-25'), amount: 400 }, { id: 'p2', date: d('2026-02-20'), amount: 170 }];
    const a = computeLedger(base, pays, d('2026-03-01'));
    expect(a.payments[1].interest.toFixed(2)).toBe('70.00');
    expect(a.payments[1].principal.toFixed(2)).toBe('100.00');
    const b = computeLedger(base, [{ ...pays[0], amount: 100 }, pays[1]], d('2026-03-01'));
    expect(b.payments[1].interest.toFixed(2)).toBe('100.00');
    expect(b.payments[1].principal.toFixed(2)).toBe('70.00');
    expect(b.principalOpen.toFixed(2)).toBe('930.00');
  });
});

describe('tipos de cobrança', () => {
  it('só juros: juros vencem todo mês e o principal no final; total a receber projetado', () => {
    const r = computeLedger(base, [], d('2026-01-10'));
    expect(r.termPeriods).toBe(5);
    expect(r.nextDue?.amount.toFixed(2)).toBe('100.00');
    expect(r.futureInterest.toFixed(2)).toBe('400.00');
    expect(r.totalToReceive.toFixed(2)).toBe('1500.00');
    expect(r.periods[4].amountDue.toFixed(2)).toBe('1100.00');
  });

  it('parcelas fixas (Price): R$ 1.000 a 10% em 2 meses = 2 × R$ 576,19', () => {
    const t: BalanceTerms = { ...base, billingType: 'FIXED_INSTALLMENTS', maturityDate: d('2026-03-10') };
    const s = simulateBalance(t);
    expect(s.periods.map((p) => p.amountDue.toFixed(2))).toEqual(['576.19', '576.19']);
    // pagando a parcela adiantada não fica atrasado
    const r = computeLedger(t, [{ id: 'p1', date: d('2026-01-30'), amount: 576.19 }], d('2026-02-20'));
    expect(r.status).toBe('ON_TIME');
    expect(r.overdueAmount.toFixed(2)).toBe('0.00');
    expect(r.nextDue?.amount.toFixed(2)).toBe('576.19');
  });

  it('parcelas fixas: pagamento extra reduz o valor das próximas parcelas, mantendo o prazo', () => {
    const t: BalanceTerms = { ...base, billingType: 'FIXED_INSTALLMENTS', maturityDate: d('2026-04-10') };
    const r = computeLedger(t, [{ id: 'p1', date: d('2026-01-30'), amount: 702.11 }], d('2026-02-11'));
    const s = simulateBalance(t);
    expect(s.periods[0].amountDue.toFixed(2)).toBe('402.11');
    expect(Number(r.nextDue!.amount)).toBeLessThan(402.11);
    expect(r.periods.length).toBe(3);
  });

  it('pagamento único: juros acumulam e tudo vence no final', () => {
    const t: BalanceTerms = { ...base, billingType: 'SINGLE_PAYMENT', maturityDate: d('2026-04-10') };
    const s = simulateBalance(t);
    expect(s.totalToReceive.toFixed(2)).toBe('1300.00');
    const c = simulateBalance({ ...t, pendingInterestMode: 'CAPITALIZE' });
    expect(c.totalToReceive.toFixed(2)).toBe('1331.00');
    const r = computeLedger(t, [], d('2026-03-01'));
    expect(r.status).toBe('ON_TIME');
    expect(r.nextDue?.date.toISOString().slice(0, 10)).toBe('2026-04-10');
  });

  it('taxa diária e semanal valem exatamente para o período', () => {
    expect(countPeriods(d('2026-01-01'), d('2026-01-11'), 'DAILY')).toBe(10);
    const daily = simulateBalance({ ...base, ratePct: 1, ratePeriod: 'DAILY', billingType: 'SINGLE_PAYMENT', maturityDate: d('2026-01-20') });
    expect(daily.totalInterest.toFixed(2)).toBe('100.00');
    const weekly = simulateBalance({ ...base, ratePct: 5, ratePeriod: 'WEEKLY', billingType: 'INTEREST_ONLY', maturityDate: d('2026-02-07') });
    expect(weekly.termPeriods).toBe(4);
    expect(weekly.totalInterest.toFixed(2)).toBe('200.00');
  });
});

describe('atraso', () => {
  const late: BalanceTerms = { ...base, lateFineRate: 2, lateInterestMonthly: 1 };
  it('marca atrasado após o vencimento e soma multa e mora ao saldo', () => {
    const r = computeLedger(late, [], d('2026-02-25'));
    expect(r.status).toBe('OVERDUE');
    expect(r.daysLate).toBe(15);
    // multa 2% de 100 = 2,00; mora 1% a.m. sobre 100 por 15 dias = 0,50
    expect(r.chargesPending.toFixed(2)).toBe('2.50');
    expect(r.balance.toFixed(2)).toBe('1202.50');
  });
  it('no dia do vencimento ainda não está atrasado', () => {
    const r = computeLedger(late, [], d('2026-02-10'));
    expect(r.status).toBe('DUE_TODAY');
    expect(r.chargesPending.toFixed(2)).toBe('0.00');
  });
  it('pagamento em atraso quita encargos antes dos juros', () => {
    const r = computeLedger(late, [{ id: 'p1', date: d('2026-02-25'), amount: 102.5 }], d('2026-02-25'));
    expect(r.payments[0].charges.toFixed(2)).toBe('2.50');
    expect(r.payments[0].interest.toFixed(2)).toBe('100.00');
    expect(r.status).toBe('ON_TIME');
  });
  it('após o vencimento final os juros continuam correndo', () => {
    const r = computeLedger(base, [], d('2026-07-15'));
    expect(r.periods.filter((p) => !p.projected).length).toBe(7); // 10/06→10/07 e 10/07→10/08
    expect(r.interestPending.toFixed(2)).toBe('700.00');
  });
});

import { valorPorExtenso } from '../src/lib/extenso.js';
describe('valor por extenso', () => {
  it.each([
    [1000, 'mil reais'],
    [1, 'um real'],
    [0.5, 'cinquenta centavos'],
    [1150.5, 'mil cento e cinquenta reais e cinquenta centavos'],
    [2500, 'dois mil e quinhentos reais'],
    [1234.56, 'mil duzentos e trinta e quatro reais e cinquenta e seis centavos'],
    [1000000, 'um milhão de reais'],
    [1200000, 'um milhão e duzentos mil reais'],
    [101, 'cento e um reais'],
    [21000, 'vinte e um mil reais'],
  ])('%s → %s', (v, txt) => expect(valorPorExtenso(v)).toBe(txt));
});
