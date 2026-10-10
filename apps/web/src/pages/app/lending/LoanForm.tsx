import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../../lib/api';
import { brl, dateBR, pct, todayISO, maskDocument } from '../../../lib/format';
import { BILLING_TYPE, RATE_PERIOD, RATE_PERIOD_NAME } from '../../../lib/labels';
import type { BalanceLoan, BalanceSimulation, Client, LendingSettings } from '../../../lib/types';
import { Loading, ErrorState, Field, Alert, useToast, errorMessage } from '../../../components/ui';
import { useDebounced } from '../../../components/lending';
import { ClientForm } from '../ClientsPages';

export interface TermsValues { amount: string; ratePct: string; ratePeriod: string; startDate: string; maturityDate: string; billingType: string; pendingInterestMode: string; lateFineRate: string; lateInterestMonthly: string }

/** Soma n períodos a uma data AAAA-MM-DD (mês mantém o dia quando possível). */
export function addPeriodsISO(iso: string, n: number, period: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  if (period === 'MONTHLY') {
    const day = d.getUTCDate();
    const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
  }
  const days = { DAILY: 1, WEEKLY: 7, BIWEEKLY: 15 }[period] ?? 30;
  d.setUTCDate(d.getUTCDate() + n * days);
  return d.toISOString().slice(0, 10);
}

const PERIOD_PLURAL: Record<string, [string, string]> = { MONTHLY: ['mês', 'meses'], WEEKLY: ['semana', 'semanas'], BIWEEKLY: ['quinzena', 'quinzenas'], DAILY: ['dia', 'dias'] };

/** Campos de condições (valor, taxa, período, datas e tipo de cobrança). */
export function TermsFields({ v, set, showAdvanced = true }: { v: TermsValues; set: (k: keyof TermsValues, val: string) => void; showAdvanced?: boolean }) {
  const [term, setTerm] = useState('');
  const applyTerm = (n: string, period = v.ratePeriod, start = v.startDate) => { setTerm(n); const k = Number(n); if (k > 0 && start) set('maturityDate', addPeriodsISO(start, k, period)); };
  return (
    <>
      <Field label="Valor emprestado (R$)"><input className="amount-input" type="number" inputMode="decimal" step="0.01" min="0" placeholder="0,00" value={v.amount} onChange={(e) => set('amount', e.target.value)} /></Field>
      <div className="form-row">
        <Field label="Taxa de juros (%)"><input type="number" inputMode="decimal" step="0.01" min="0" value={v.ratePct} onChange={(e) => set('ratePct', e.target.value)} /></Field>
        <Field label="Período da taxa"><select value={v.ratePeriod} onChange={(e) => { set('ratePeriod', e.target.value); if (term) applyTerm(term, e.target.value); }}>{['MONTHLY', 'WEEKLY', 'BIWEEKLY', 'DAILY'].map((k) => <option key={k} value={k}>{RATE_PERIOD_NAME[k]} ({RATE_PERIOD[k]})</option>)}</select></Field>
        <Field label="Data do empréstimo"><input type="date" value={v.startDate} onChange={(e) => { set('startDate', e.target.value); if (term) applyTerm(term, v.ratePeriod, e.target.value); }} /></Field>
        <Field label={`Prazo (em ${PERIOD_PLURAL[v.ratePeriod]?.[1] ?? 'períodos'})`} help="Opcional: preenche o vencimento"><input type="number" min="1" inputMode="numeric" value={term} onChange={(e) => applyTerm(e.target.value)} /></Field>
      </div>
      <Field label="Data de vencimento"><input type="date" value={v.maturityDate} onChange={(e) => { setTerm(''); set('maturityDate', e.target.value); }} /></Field>
      <label className="field"><span style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)' }}>Tipo de cobrança</span></label>
      <div className="option-cards">
        {Object.entries(BILLING_TYPE).map(([k, b]) => <button type="button" key={k} className={`option-card ${v.billingType === k ? 'active' : ''}`} onClick={() => set('billingType', k)}><strong>{b.label}</strong><span>{b.hint}</span></button>)}
      </div>
      {showAdvanced && (
        <details className="mb"><summary style={{ cursor: 'pointer', color: 'var(--brand-secondary)', marginBottom: 8 }}>Juros não pagos, multa e mora</summary>
          <Field label="Juros não pagos no período" help="Padrão definido em Configurações"><select value={v.pendingInterestMode} onChange={(e) => set('pendingInterestMode', e.target.value)}><option value="SEPARATE">Ficam separados (não geram juros)</option><option value="CAPITALIZE">São somados ao principal</option></select></Field>
          <div className="form-row">
            <Field label="Multa por atraso (%)" help="Opcional. 0 = sem multa"><input type="number" step="0.01" min="0" value={v.lateFineRate} onChange={(e) => set('lateFineRate', e.target.value)} /></Field>
            <Field label="Juros de mora (% ao mês)" help="Proporcional aos dias de atraso"><input type="number" step="0.01" min="0" value={v.lateInterestMonthly} onChange={(e) => set('lateInterestMonthly', e.target.value)} /></Field>
          </div>
        </details>
      )}
    </>
  );
}

/** Resultado da simulação: quanto vai receber, juros e cronograma. */
export function SimulationResult({ v }: { v: TermsValues }) {
  const dv = useDebounced(v);
  const ready = Number(dv.amount) > 0 && dv.ratePct !== '' && dv.startDate && dv.maturityDate;
  const q = useQuery({
    queryKey: ['lending-sim', dv],
    queryFn: () => api<BalanceSimulation>('lending/simulate', { body: { amount: dv.amount, ratePct: dv.ratePct, ratePeriod: dv.ratePeriod, startDate: dv.startDate, maturityDate: dv.maturityDate, billingType: dv.billingType, pendingInterestMode: dv.pendingInterestMode || undefined } }),
    enabled: !!ready,
    retry: false,
  });
  const [all, setAll] = useState(false);
  if (!ready) return <p className="muted">Preencha valor, taxa e datas para ver quanto você vai receber.</p>;
  if (q.isLoading) return <Loading text="Calculando..." />;
  if (q.error) return <Alert kind="error">{errorMessage(q.error)}</Alert>;
  const s = q.data!;
  const rows = all ? s.periods : s.periods.slice(0, 12);
  return (
    <>
      <div className="split">
        <div className="box full"><div className="label">Você vai receber</div><div className="value">{brl(s.totalToReceive)}</div></div>
        <div className="box"><div className="label">Lucro (juros)</div><div className="value" style={{ color: 'var(--success)' }}>{brl(s.totalInterest)}</div></div>
        <div className="box"><div className="label">{v.billingType === 'FIXED_INSTALLMENTS' ? 'Parcela' : v.billingType === 'SINGLE_PAYMENT' ? 'Pagamento único' : 'Juros por período'}</div><div className="value">{brl(v.billingType === 'SINGLE_PAYMENT' ? s.totalToReceive : s.firstInstallment)}</div></div>
      </div>
      <p className="small muted">{s.termPeriods} período(s){v.ratePeriod !== 'MONTHLY' ? ` · equivale a ${pct(s.monthlyEquivalent)} ao mês` : ''} · considerando pagamentos em dia</p>
      <div className="table-wrap"><table className="table"><thead><tr><th>Nº</th><th>Vencimento</th><th className="num">Juros</th><th className="num">Principal</th><th className="num">A pagar</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.number}><td>{r.number}</td><td>{dateBR(r.dueDate)}</td><td className="num">{brl(r.interest)}</td><td className="num">{brl(r.principalDue)}</td><td className="num"><strong>{Number(r.amountDue) > 0 ? brl(r.amountDue) : '—'}</strong></td></tr>)}
      </tbody></table></div>
      {s.periods.length > 12 && <button className="btn sm mt" onClick={() => setAll(!all)}>{all ? 'Mostrar menos' : `Ver todos os ${s.periods.length} períodos`}</button>}
    </>
  );
}

function useDefaults() {
  return useQuery({ queryKey: ['lending-settings'], queryFn: () => api<{ lending: LendingSettings }>('lending/settings') });
}

export function SimulatorPage() {
  const defaults = useDefaults();
  const [v, setV] = useState<TermsValues>({ amount: '1000', ratePct: '10', ratePeriod: 'MONTHLY', startDate: todayISO(), maturityDate: addPeriodsISO(todayISO(), 3, 'MONTHLY'), billingType: 'INTEREST_ONLY', pendingInterestMode: '', lateFineRate: '0', lateInterestMonthly: '0' });
  const set = (k: keyof TermsValues, val: string) => setV((s) => ({ ...s, [k]: val }));
  const nav = useNavigate();
  useEffect(() => { if (defaults.data) setV((s) => ({ ...s, pendingInterestMode: s.pendingInterestMode || defaults.data.lending.pendingInterestMode })); }, [defaults.data]);
  return (
    <>
      <h1 className="mb">Simulador</h1>
      <div className="grid cols-2">
        <div className="card"><TermsFields v={v} set={set} showAdvanced={false} /></div>
        <div className="card"><h3>Resultado</h3><SimulationResult v={v} />
          <button className="btn primary block mt" onClick={() => nav(`/app/emprestimos/novo?${new URLSearchParams({ amount: v.amount, ratePct: v.ratePct, ratePeriod: v.ratePeriod, startDate: v.startDate, maturityDate: v.maturityDate, billingType: v.billingType }).toString()}`)}>Cadastrar este empréstimo</button>
        </div>
      </div>
    </>
  );
}

export function BalanceLoanFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const defaults = useDefaults();
  const clients = useQuery({ queryKey: ['clients', 'all'], queryFn: () => api<Client[]>('clients') });
  const existing = useQuery({ queryKey: ['balance-loan', id], queryFn: () => api<BalanceLoan>(`lending/loans/${id}`), enabled: editing });
  const [newClient, setNewClient] = useState(false);
  const [clientId, setClientId] = useState(params.get('clientId') ?? '');
  const [disbursementMethod, setDisb] = useState('PIX');
  const [notes, setNotes] = useState('');
  const [v, setV] = useState<TermsValues>({
    amount: params.get('amount') ?? '', ratePct: params.get('ratePct') ?? '', ratePeriod: params.get('ratePeriod') ?? 'MONTHLY', startDate: params.get('startDate') ?? todayISO(),
    maturityDate: params.get('maturityDate') ?? addPeriodsISO(todayISO(), 1, 'MONTHLY'), billingType: params.get('billingType') ?? 'INTEREST_ONLY', pendingInterestMode: '', lateFineRate: '', lateInterestMonthly: '',
  });
  const set = (k: keyof TermsValues, val: string) => setV((s) => ({ ...s, [k]: val }));
  useEffect(() => {
    if (!editing && defaults.data) setV((s) => ({ ...s, pendingInterestMode: s.pendingInterestMode || defaults.data.lending.pendingInterestMode, lateFineRate: s.lateFineRate || defaults.data.lending.lateFineRate, lateInterestMonthly: s.lateInterestMonthly || defaults.data.lending.lateInterestMonthly }));
  }, [defaults.data, editing]);
  useEffect(() => {
    const l = existing.data;
    if (!l) return;
    setClientId(l.clientId); setDisb(l.disbursementMethod ?? ''); setNotes(l.notes ?? '');
    setV({ amount: l.principalAmount, ratePct: String(Number(l.periodRate)), ratePeriod: l.periodicity, startDate: l.disbursementDate.slice(0, 10), maturityDate: l.maturityDate.slice(0, 10), billingType: l.billingType, pendingInterestMode: l.pendingInterestMode, lateFineRate: String(Number(l.lateFineRate)), lateInterestMonthly: String(Number(l.lateInterestMonthly)) });
  }, [existing.data]);
  const save = useMutation({
    mutationFn: () => {
      const body = { clientId, amount: v.amount, ratePct: v.ratePct, ratePeriod: v.ratePeriod, startDate: v.startDate, maturityDate: v.maturityDate, billingType: v.billingType, pendingInterestMode: v.pendingInterestMode || undefined, lateFineRate: v.lateFineRate || '0', lateInterestMonthly: v.lateInterestMonthly || '0', disbursementMethod: disbursementMethod || null, notes: notes || null };
      return editing ? api<{ id: string }>(`lending/loans/${id}`, { method: 'PUT', body }) : api<{ id: string }>('lending/loans', { body });
    },
    onSuccess: (l) => {
      toast(editing ? 'Empréstimo atualizado e recalculado' : 'Empréstimo cadastrado com sucesso', 'success');
      qc.invalidateQueries({ queryKey: ['lending-loans'] }); qc.invalidateQueries({ queryKey: ['lending-dashboard'] }); qc.invalidateQueries({ queryKey: ['balance-loan', l.id] });
      nav(`/app/emprestimos/${l.id}`, { replace: editing });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const clientOptions = useMemo(() => clients.data?.filter((c) => c.status !== 'BLOCKED' || c.id === clientId) ?? [], [clients.data, clientId]);
  if (editing && existing.isLoading) return <Loading />;
  if (editing && existing.error) return <ErrorState error={existing.error} />;
  const canSave = clientId && Number(v.amount) > 0 && v.ratePct !== '' && v.maturityDate;
  return (
    <>
      <h1 className="mb">{editing ? `Editar empréstimo nº ${existing.data?.number}` : 'Novo empréstimo'}</h1>
      {editing && <Alert kind="info">Ao salvar, todos os pagamentos já lançados são recalculados com as novas condições.</Alert>}
      <div className="grid cols-2">
        <div className="card">
          <Field label="Cliente">
            <div className="flex" style={{ flexWrap: 'nowrap' }}>
              <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ flex: 1 }}><option value="">Selecione...</option>{clientOptions.map((c) => <option key={c.id} value={c.id}>{c.name} — {maskDocument(c.document)}</option>)}</select>
              <button type="button" className="btn" onClick={() => setNewClient(true)}>+ Cliente</button>
            </div>
          </Field>
          <TermsFields v={v} set={set} />
          <div className="form-row">
            <Field label="Dinheiro entregue por"><select value={disbursementMethod} onChange={(e) => setDisb(e.target.value)}><option value="PIX">PIX</option><option value="transferência bancária">Transferência</option><option value="dinheiro em espécie">Dinheiro</option><option value="">Não informar</option></select></Field>
          </div>
          <Field label="Observações"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <div className="card">
          <h3>Simulação</h3>
          <SimulationResult v={v} />
          <button className="btn primary block lg mt" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Salvando...' : editing ? 'Salvar alterações' : 'Cadastrar empréstimo'}</button>
          {!clientId && <p className="small muted mt">Selecione o cliente para cadastrar.</p>}
        </div>
      </div>
      {newClient && <ClientForm onClose={() => setNewClient(false)} onSaved={(c) => { setNewClient(false); qc.invalidateQueries({ queryKey: ['clients'] }); setClientId(c.id); }} />}
    </>
  );
}
