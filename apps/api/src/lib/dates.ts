import { addDays, addMonths, differenceInCalendarDays, format, parseISO, startOfDay } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { Periodicity } from '@prisma/client';

/** Datas "de calendário" são armazenadas como Date UTC à meia-noite (coluna DATE). */
export const dateOnly = (d: Date | string): Date => {
  const dt = typeof d === 'string' ? parseISO(d.length === 10 ? d + 'T00:00:00Z' : d) : d;
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
};

export const isoDate = (d: Date): string => format(d, 'yyyy-MM-dd');
export const isoDateUTC = (d: Date): string => d.toISOString().slice(0, 10);

export const formatBRDate = (d: Date | string | null | undefined): string => {
  if (!d) return '';
  const dt = typeof d === 'string' ? parseISO(d) : d;
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
};

export const formatBRDateTime = (d: Date, tz = 'America/Sao_Paulo'): string => {
  const z = toZonedTime(d, tz);
  return format(z, 'dd/MM/yyyy HH:mm');
};

/** "Hoje" no fuso horário da empresa, como data de calendário UTC. */
export const todayIn = (tz: string, now = new Date()): Date => {
  const z = toZonedTime(now, tz);
  return new Date(Date.UTC(z.getFullYear(), z.getMonth(), z.getDate()));
};

export const daysBetween = (a: Date, b: Date): number => differenceInCalendarDays(dateOnly(b), dateOnly(a));

export const periodDays = (p: Periodicity): number =>
  ({ MONTHLY: 30, BIWEEKLY: 15, WEEKLY: 7, DAILY: 1 })[p];

/** Data de vencimento da parcela n (1-based) a partir do primeiro vencimento. */
export const nthDueDate = (first: Date, n: number, p: Periodicity): Date => {
  const f = dateOnly(first);
  if (p === 'MONTHLY') return addMonthsKeepingDay(f, n - 1);
  return dateOnly(addDays(f, (n - 1) * periodDays(p)));
};

/** Soma meses mantendo o dia quando possível (31/01 + 1 mês => 28/02 ou 29/02). */
export function addMonthsKeepingDay(d: Date, months: number): Date {
  const day = d.getUTCDate();
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(day, lastDay)));
}

/** Converte data local (fuso) + hora em instante UTC. */
export const zonedDateTime = (dateUTC: Date, hour: number, minute: number, tz: string): Date =>
  fromZonedTime(
    new Date(dateUTC.getUTCFullYear(), dateUTC.getUTCMonth(), dateUTC.getUTCDate(), hour, minute, 0),
    tz,
  );

export const monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export const monthRange = (key: string): { start: Date; end: Date } => {
  const [y, m] = key.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
};

export const previousMonthKey = (key: string): string => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return monthKey(d);
};

export { addDays, addMonths, startOfDay };
