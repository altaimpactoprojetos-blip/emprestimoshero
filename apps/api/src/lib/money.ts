import { Decimal } from 'decimal.js';

// Configuração global: precisão alta nos cálculos intermediários; arredondamento explícito só ao final.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type Dec = Decimal;

export const D = (v: Decimal.Value | null | undefined): Decimal => new Decimal(v ?? 0);
export const ZERO = new Decimal(0);

/** Arredonda para centavos (2 casas) com regra HALF_UP — regra oficial da plataforma. */
export const cents = (v: Decimal.Value): Decimal => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Arredonda taxa (6 casas). */
export const rate6 = (v: Decimal.Value): Decimal => new Decimal(v).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

export const toNumber = (v: Decimal.Value): number => new Decimal(v).toNumber();

export const formatBRL = (v: Decimal.Value): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(new Decimal(v).toNumber());

export const formatPct = (v: Decimal.Value, digits = 2): string =>
  `${new Decimal(v).toDecimalPlaces(digits, Decimal.ROUND_HALF_UP).toFixed(digits).replace('.', ',')}%`;

export const sum = (values: Decimal.Value[]): Decimal => values.reduce<Decimal>((acc, v) => acc.plus(v), ZERO);

export const max0 = (v: Decimal.Value): Decimal => Decimal.max(0, v);
