/**
 * Modelos de contrato: texto simples com marcadores {{campo}}.
 *  - Linhas iniciadas por "# " viram título; "## " viram subtítulo.
 *  - Linhas em branco separam parágrafos.
 *  - {{cronograma}} insere a tabela de parcelas; {{assinaturas}} insere as linhas de assinatura.
 * O mesmo texto renderizado é usado na pré-visualização (HTML) e no PDF (blocos), garantindo
 * conteúdo idêntico e congelado no contrato.
 */
import type { Block } from '../services/pdf.js';

export interface TemplateVars { [key: string]: string }

export const TEMPLATE_PLACEHOLDERS: Array<{ key: string; label: string }> = [
  { key: 'empresa.nome', label: 'Nome da empresa credora' },
  { key: 'empresa.razao_social', label: 'Razão social da credora' },
  { key: 'empresa.cnpj', label: 'CNPJ da credora' },
  { key: 'empresa.endereco', label: 'Endereço da credora' },
  { key: 'cliente.nome', label: 'Nome do cliente' },
  { key: 'cliente.documento', label: 'CPF/CNPJ do cliente' },
  { key: 'cliente.endereco', label: 'Endereço do cliente' },
  { key: 'cliente.email', label: 'E-mail do cliente' },
  { key: 'cliente.telefone', label: 'Telefone do cliente' },
  { key: 'contrato.numero', label: 'Número do empréstimo' },
  { key: 'contrato.data', label: 'Data de emissão' },
  { key: 'valor.solicitado', label: 'Valor solicitado' },
  { key: 'valor.principal', label: 'Principal financiado' },
  { key: 'valor.liberado', label: 'Valor líquido liberado' },
  { key: 'valor.liberado_extenso', label: 'Valor liberado por extenso' },
  { key: 'valor.tarifa', label: 'Tarifas' },
  { key: 'valor.iof', label: 'IOF' },
  { key: 'valor.total', label: 'Total a pagar' },
  { key: 'valor.juros', label: 'Total de juros' },
  { key: 'parcelas.quantidade', label: 'Quantidade de parcelas' },
  { key: 'parcelas.valor', label: 'Valor da parcela' },
  { key: 'parcelas.periodicidade', label: 'Periodicidade' },
  { key: 'parcelas.primeiro_vencimento', label: 'Primeiro vencimento' },
  { key: 'parcelas.ultimo_vencimento', label: 'Último vencimento' },
  { key: 'taxa.mensal', label: 'Taxa de juros mensal' },
  { key: 'taxa.anual', label: 'Taxa de juros anual' },
  { key: 'taxa.cet_mensal', label: 'CET mensal' },
  { key: 'taxa.cet_anual', label: 'CET anual' },
  { key: 'taxa.metodo', label: 'Método de cálculo' },
  { key: 'atraso.multa', label: 'Multa por atraso' },
  { key: 'atraso.mora', label: 'Juros de mora mensal' },
  { key: 'pagamento.formas', label: 'Formas de pagamento' },
  { key: 'data.liberacao', label: 'Data prevista de liberação' },
  { key: 'cronograma', label: 'Tabela do cronograma de parcelas' },
  { key: 'assinaturas', label: 'Linhas de assinatura' },
];

export const DEFAULT_CONTRACT_TEMPLATE = `# CONTRATO DE MÚTUO (EMPRÉSTIMO DE DINHEIRO) Nº {{contrato.numero}}

## 1. Partes
CREDORA: {{empresa.razao_social}}, inscrita no CNPJ sob o nº {{empresa.cnpj}}, com sede em {{empresa.endereco}}, doravante denominada CREDORA.

DEVEDOR(A): {{cliente.nome}}, inscrito(a) no CPF/CNPJ sob o nº {{cliente.documento}}, residente/estabelecido(a) em {{cliente.endereco}}, e-mail {{cliente.email}}, telefone {{cliente.telefone}}, doravante denominado(a) DEVEDOR(A).

## 2. Objeto e valor
A CREDORA concede ao(à) DEVEDOR(A) empréstimo no valor solicitado de {{valor.solicitado}}, sendo o principal financiado de {{valor.principal}} e o valor líquido liberado de {{valor.liberado}} ({{valor.liberado_extenso}}), com previsão de liberação em {{data.liberacao}}, já considerados tarifa de {{valor.tarifa}} e IOF de {{valor.iof}}.

## 3. Encargos e condições financeiras
Sobre o principal incidem juros remuneratórios de {{taxa.mensal}} ao mês ({{taxa.anual}} ao ano), calculados pelo método {{taxa.metodo}}. O Custo Efetivo Total (CET) é de {{taxa.cet_mensal}} ao mês e {{taxa.cet_anual}} ao ano. O total de juros previsto é de {{valor.juros}} e o valor total a pagar é de {{valor.total}}.

## 4. Pagamento
O(A) DEVEDOR(A) pagará o empréstimo em {{parcelas.quantidade}} parcela(s) com periodicidade {{parcelas.periodicidade}}, no valor de {{parcelas.valor}} cada (salvo variação decorrente do método de cálculo indicada no cronograma), vencendo a primeira em {{parcelas.primeiro_vencimento}} e a última em {{parcelas.ultimo_vencimento}}, conforme cronograma abaixo.

{{cronograma}}

Formas de pagamento: {{pagamento.formas}}

## 5. Atraso
Em caso de atraso, incidirão sobre a parcela em aberto multa de {{atraso.multa}} e juros de mora de {{atraso.mora}} ao mês, calculados por dia de atraso, sem prejuízo das medidas de cobrança cabíveis. Os pagamentos recebidos serão imputados na seguinte ordem: encargos de atraso, juros e principal.

## 6. Quitação antecipada
O(A) DEVEDOR(A) poderá quitar antecipadamente, total ou parcialmente, o saldo devedor, com redução proporcional dos juros das parcelas ainda não vencidas, calculada pro rata dia sobre o período em curso.

## 7. Renegociação
As partes poderão renegociar o saldo devedor mediante novo instrumento, que substituirá as parcelas renegociadas sem duplicidade do débito. Qualquer alteração deste contrato após a assinatura será formalizada por aditivo vinculado a este instrumento.

## 8. Proteção de dados
Os dados pessoais serão tratados para execução deste contrato e cumprimento de obrigações legais, nos termos da Lei nº 13.709/2018 (LGPD).

## 9. Foro
Fica eleito o foro da comarca da sede da CREDORA para dirimir questões oriundas deste contrato.

Local e data: {{contrato.data}}.

{{assinaturas}}`;

export function renderTemplate(content: string, vars: TemplateVars): string {
  return content.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key: string) => (key === 'cronograma' || key === 'assinaturas' ? m : (vars[key] ?? `[${key}]`)));
}

export interface ScheduleForDoc { rows: Array<[string, string, string, string, string]> }

/** Converte o texto renderizado em blocos (PDF) ou HTML (pré-visualização). */
export function parseToBlocks(text: string, schedule: ScheduleForDoc, signers: string[]): Block[] {
  const blocks: Block[] = [];
  const paragraphs = text.split(/\n\s*\n/);
  for (const raw of paragraphs) {
    const p = raw.trim();
    if (!p) continue;
    if (p === '{{cronograma}}') {
      blocks.push({ type: 'table', columns: [{ label: 'Nº', width: 0.6 }, { label: 'Vencimento', width: 1.2 }, { label: 'Principal', width: 1.2, align: 'right' }, { label: 'Juros', width: 1.2, align: 'right' }, { label: 'Parcela', width: 1.2, align: 'right' }], rows: schedule.rows });
      continue;
    }
    if (p === '{{assinaturas}}') { blocks.push({ type: 'signature', lines: signers }); continue; }
    for (const line of p.split('\n')) {
      const l = line.trim();
      if (l.startsWith('# ')) blocks.push({ type: 'title', text: l.slice(2) });
      else if (l.startsWith('## ')) blocks.push({ type: 'heading', text: l.slice(3) });
      else if (l) blocks.push({ type: 'paragraph', text: l });
    }
  }
  return blocks;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function blocksToHtml(blocks: Block[]): string {
  return blocks.map((b) => {
    switch (b.type) {
      case 'title': return `<h1>${esc(b.text)}</h1>`;
      case 'heading': return `<h2>${esc(b.text)}</h2>`;
      case 'paragraph': return `<p>${esc(b.text)}</p>`;
      case 'small': return `<p class="small">${esc(b.text)}</p>`;
      case 'kv': return `<table>${b.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
      case 'table': return `<table><thead><tr>${b.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${b.columns[i].align ?? 'left'}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      case 'signature': return b.lines.map((l) => `<div style="margin:36px auto 0;max-width:420px;border-top:1px solid #000;text-align:center;padding-top:4px">${esc(l)}</div>`).join('');
      case 'spacer': return '<br/>';
    }
  }).join('\n');
}

/** Valor por extenso em reais (até bilhões). */
export function numberToWordsBRL(value: number): string {
  const units = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const tens = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const hundreds = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  const below1000 = (n: number): string => {
    if (n === 0) return '';
    if (n === 100) return 'cem';
    const h = Math.floor(n / 100), r = n % 100;
    const parts: string[] = [];
    if (h) parts.push(hundreds[h]);
    if (r < 20) { if (r) parts.push(units[r]); }
    else { parts.push(tens[Math.floor(r / 10)]); if (r % 10) parts.push(units[r % 10]); }
    return parts.join(' e ');
  };
  const scales: Array<[number, string, string]> = [[1e9, 'bilhão', 'bilhões'], [1e6, 'milhão', 'milhões'], [1e3, 'mil', 'mil']];
  let int = Math.floor(Math.abs(value));
  const cents = Math.round((Math.abs(value) - int) * 100);
  const parts: string[] = [];
  for (const [div, sing, plur] of scales) {
    const q = Math.floor(int / div);
    if (q) { parts.push(div === 1e3 ? (q === 1 ? 'mil' : `${below1000(q)} mil`) : `${below1000(q)} ${q === 1 ? sing : plur}`); int %= div; }
  }
  if (int) parts.push(below1000(int));
  let text = parts.join(' e ') || 'zero';
  text += Math.floor(Math.abs(value)) === 1 ? ' real' : ' reais';
  if (cents) text += ` e ${below1000(cents)} centavo${cents > 1 ? 's' : ''}`;
  return text;
}
