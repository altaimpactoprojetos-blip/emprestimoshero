import { D, cents } from './money.js';
import type { Decimal } from './money.js';

const UNITS = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function below1000(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const h = Math.floor(n / 100), r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(HUNDREDS[h]);
  if (r < 20) { if (r) parts.push(UNITS[r]); } else { parts.push(TENS[Math.floor(r / 10)]); if (r % 10) parts.push(UNITS[r % 10]); }
  return parts.join(' e ');
}

/** Número inteiro por extenso ("mil cento e cinquenta", "dois mil e quinhentos", "um milhão e duzentos mil"). */
export function inteiroPorExtenso(value: number): string {
  if (value === 0) return 'zero';
  const scales: Array<[number, string, string]> = [[1e9, 'bilhão', 'bilhões'], [1e6, 'milhão', 'milhões'], [1e3, 'mil', 'mil'], [1, '', '']];
  const groups: Array<{ text: string; value: number }> = [];
  let rest = Math.floor(value);
  for (const [div, sing, plur] of scales) {
    const q = Math.floor(rest / div);
    rest %= div;
    if (!q) continue;
    let text: string;
    if (div === 1) text = below1000(q);
    else if (div === 1e3) text = q === 1 ? 'mil' : `${below1000(q)} mil`;
    else text = `${below1000(q)} ${q === 1 ? sing : plur}`;
    groups.push({ text, value: q });
  }
  return groups.reduce((acc, g, idx) => {
    if (idx === 0) return g.text;
    const last = idx === groups.length - 1;
    const sep = last && (g.value < 100 || g.value % 100 === 0) ? ' e ' : last ? ' ' : ', ';
    return acc + sep + g.text;
  }, '');
}

/** Valor em reais por extenso: R$ 1.150,50 → "mil cento e cinquenta reais e cinquenta centavos". */
export function valorPorExtenso(value: Decimal.Value): string {
  const v = cents(D(value).abs());
  const int = v.floor().toNumber();
  const c = v.minus(v.floor()).times(100).round().toNumber();
  const parts: string[] = [];
  if (int > 0) {
    const words = inteiroPorExtenso(int);
    const de = int % 1e6 === 0 ? ' de' : ''; // "um milhão de reais"
    parts.push(`${words}${de} ${int === 1 ? 'real' : 'reais'}`);
  }
  if (c > 0) parts.push(`${below1000(c)} ${c === 1 ? 'centavo' : 'centavos'}`);
  if (!parts.length) return 'zero real';
  return parts.join(' e ');
}
