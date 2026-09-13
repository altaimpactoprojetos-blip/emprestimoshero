import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadFile, openFile } from '../../lib/api';
import { brl, dateBR, dateTimeBR, monthLabel, currentMonthKey, todayISO } from '../../lib/format';
import type { Client } from '../../lib/types';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader, Loading, ErrorState, DataTable, useToast, errorMessage, Tabs, Stat, Alert, Modal, Field, KV, Badge } from '../../components/ui';

interface Totals { disbursedCount: number; disbursedAmount: string; principalFinanced: string; receivedTotal: string; receivedCount: number; principal: string; interest: string; charges: string; discounts: string; reversals: string; reversalsCount: number; renegotiatedBalance: string; expenses: string; result: string; overdueCount: number; overdueAmount: string; overdueClients: number; projectionCount: number; projectionAmount: string; projectionMonth: string }
interface Report { id?: string; version?: number; referenceDate?: string; automatic?: boolean; month: string; asOf: string; totals: Totals; previous?: Totals; preview?: boolean; details: { loans: Array<{ id: string; number: number; client: string; disbursedAt: string; disbursed: string; principal: string; installments: number }>; payments: Array<{ id: string; paidAt: string; client: string; loan: number; installment: number; amount: string; principal: string; interest: string; charges: string; discount: string; method: string; receivedBy: string | null; receiptNumber: number | null }>; reversals: Array<{ id: string; paidAt: string; client: string; amount: string; reason: string | null }>; expenses: Array<{ id: string; date: string; description: string; category: string; amount: string }>; overdue: Array<{ id: string; client: string; loan: number; installment: number; dueDate: string; daysLate: number; amount: string }>; projection: Array<{ id: string; client: string; loan: number; installment: number; dueDate: string; amount: string }> }; formulas: Record<string, string> }
interface Closing { id: string; referenceMonth: string; version: number; referenceDate: string; automatic: boolean }

export function ReportsPage() {
  const [tab, setTab] = useState('mensal');
  return (
    <>
      <PageHeader title="Relatórios" subtitle="Fechamentos mensais versionados, extração de recebimentos com filtros e despesas." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'mensal', label: 'Relatório mensal' }, { key: 'recebimentos', label: 'Recebimentos (filtros e exportação)' }, { key: 'despesas', label: 'Despesas' }]} />
      {tab === 'mensal' && <MonthlyTab />}
      {tab === 'recebimentos' && <ReceiptsTab />}
      {tab === 'despesas' && <ExpensesTab />}
    </>
  );
}

function Delta({ cur, prev }: { cur: string; prev?: string }) {
  if (prev === undefined) return null;
  const diff = Number(cur) - Number(prev);
  return <span className="small" style={{ color: diff >= 0 ? 'var(--success)' : 'var(--danger)' }}> ({diff >= 0 ? '+' : ''}{brl(diff)} vs. mês anterior)</span>;
}

function ReportView({ r }: { r: Report }) {
  const [detail, setDetail] = useState<string | null>(null);
  const t = r.totals; const p = r.previous;
  const row = (label: string, key: keyof Totals, extra?: string) => <tr className="row-link" onClick={() => setDetail(extra ?? null)}><td>{label}{extra && <span className="small muted"> (ver registros)</span>}</td><td className="num">{typeof t[key] === 'number' ? t[key] : brl(t[key] as string)}</td><td className="num">{p ? (typeof p[key] === 'number' ? p[key] : brl(p[key] as string)) : '—'}</td><td>{typeof t[key] !== 'number' && <Delta cur={t[key] as string} prev={p?.[key] as string | undefined} />}</td></tr>;
  return (
    <>
      {r.preview && <Alert kind="info">Prévia calculada agora, sem fechamento gravado. Ao fechar o mês, os valores e a data de referência ficam preservados em uma versão.</Alert>}
      <p className="small muted">Posição de atrasos em {dateBR(r.asOf)}. Principal recuperado é devolução de capital e não entra no resultado.</p>
      <div className="table-wrap"><table className="table"><thead><tr><th>Indicador</th><th className="num">{monthLabel(r.month)}</th><th className="num">Mês anterior</th><th></th></tr></thead><tbody>
        {row('Empréstimos liberados (quantidade)', 'disbursedCount', 'loans')}
        {row('Empréstimos liberados (valor)', 'disbursedAmount', 'loans')}
        {row('Recebimentos confirmados', 'receivedTotal', 'payments')}
        {row('Principal recuperado', 'principal', 'payments')}
        {row('Juros recebidos', 'interest', 'payments')}
        {row('Encargos de atraso recebidos', 'charges', 'payments')}
        {row('Descontos concedidos', 'discounts', 'payments')}
        {row('Estornos', 'reversals', 'reversals')}
        {row('Saldos transferidos por renegociação', 'renegotiatedBalance')}
        {row('Despesas', 'expenses', 'expenses')}
        {row('Resultado (juros + encargos − despesas)', 'result')}
        {row('Parcelas em atraso (quantidade)', 'overdueCount', 'overdue')}
        {row('Parcelas em atraso (valor)', 'overdueAmount', 'overdue')}
        {row('Clientes em atraso', 'overdueClients', 'overdue')}
        {row(`Projeção de vencimentos — ${monthLabel(t.projectionMonth)}`, 'projectionAmount', 'projection')}
      </tbody></table></div>
      {detail && (
        <Modal title="Registros que compõem o total" onClose={() => setDetail(null)} wide>
          {detail === 'loans' && <DataTable rows={r.details.loans} columns={[{ key: 'number', label: 'Nº' }, { key: 'client', label: 'Cliente' }, { key: 'disbursedAt', label: 'Liberação', render: (x) => dateBR(x.disbursedAt) }, { key: 'disbursed', label: 'Liberado', num: true, render: (x) => brl(x.disbursed) }, { key: 'principal', label: 'Principal', num: true, render: (x) => brl(x.principal) }, { key: 'installments', label: 'Parcelas', num: true }]} emptyTitle="Sem registros" />}
          {detail === 'payments' && <DataTable rows={r.details.payments} columns={[{ key: 'paidAt', label: 'Data', render: (x) => dateBR(x.paidAt) }, { key: 'client', label: 'Cliente' }, { key: 'loan', label: 'Contr./Parc.', render: (x) => `${x.loan}/${x.installment}` }, { key: 'amount', label: 'Valor', num: true, render: (x) => brl(x.amount) }, { key: 'principal', label: 'Principal', num: true, render: (x) => brl(x.principal) }, { key: 'interest', label: 'Juros', num: true, render: (x) => brl(x.interest) }, { key: 'charges', label: 'Encargos', num: true, render: (x) => brl(x.charges) }, { key: 'discount', label: 'Desconto', num: true, render: (x) => brl(x.discount) }, { key: 'receivedBy', label: 'Responsável' }]} emptyTitle="Sem registros" />}
          {detail === 'reversals' && <DataTable rows={r.details.reversals} columns={[{ key: 'paidAt', label: 'Data', render: (x) => dateBR(x.paidAt) }, { key: 'client', label: 'Cliente' }, { key: 'amount', label: 'Valor', num: true, render: (x) => brl(x.amount) }, { key: 'reason', label: 'Justificativa' }]} emptyTitle="Sem registros" />}
          {detail === 'expenses' && <DataTable rows={r.details.expenses} columns={[{ key: 'date', label: 'Data', render: (x) => dateBR(x.date) }, { key: 'description', label: 'Descrição' }, { key: 'category', label: 'Categoria' }, { key: 'amount', label: 'Valor', num: true, render: (x) => brl(x.amount) }]} emptyTitle="Sem registros" />}
          {detail === 'overdue' && <DataTable rows={r.details.overdue} columns={[{ key: 'client', label: 'Cliente' }, { key: 'loan', label: 'Contr./Parc.', render: (x) => `${x.loan}/${x.installment}` }, { key: 'dueDate', label: 'Vencimento', render: (x) => dateBR(x.dueDate) }, { key: 'daysLate', label: 'Dias', num: true }, { key: 'amount', label: 'Saldo', num: true, render: (x) => brl(x.amount) }]} emptyTitle="Sem registros" />}
          {detail === 'projection' && <DataTable rows={r.details.projection} columns={[{ key: 'client', label: 'Cliente' }, { key: 'loan', label: 'Contr./Parc.', render: (x) => `${x.loan}/${x.installment}` }, { key: 'dueDate', label: 'Vencimento', render: (x) => dateBR(x.dueDate) }, { key: 'amount', label: 'Valor', num: true, render: (x) => brl(x.amount) }]} emptyTitle="Sem registros" />}
        </Modal>
      )}
      <details className="mt"><summary style={{ cursor: 'pointer', color: 'var(--blue)' }}>Fórmulas dos indicadores</summary>{Object.values(r.formulas).map((f) => <p key={f} className="small muted">{f}</p>)}</details>
    </>
  );
}

function MonthlyTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [month, setMonth] = useState(currentMonthKey());
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['reports', 'monthly'], queryFn: () => api<Closing[]>('reports/monthly') });
  const preview = useQuery({ queryKey: ['reports', 'preview', month], queryFn: () => api<Report>(`reports/monthly/preview?month=${month}`), enabled: !selected });
  const detail = useQuery({ queryKey: ['reports', 'detail', selected], queryFn: () => api<Report>(`reports/monthly/${selected}`), enabled: !!selected });
  const close = useMutation({ mutationFn: () => api<Closing>('reports/monthly/close', { body: { month } }), onSuccess: (c) => { toast(`Fechamento de ${monthLabel(month)} gravado (versão ${c.version})`, 'success'); qc.invalidateQueries({ queryKey: ['reports'] }); setSelected(c.id); }, onError: (e) => toast(errorMessage(e), 'error') });
  const current = selected ? detail.data : preview.data;
  return (
    <div className="grid cols-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2.2fr)' }}>
      <div className="card">
        <h3>Fechamentos</h3>
        <p className="small muted">O worker fecha automaticamente o mês anterior no primeiro dia de cada mês. Novos fechamentos criam versões; as anteriores ficam preservadas.</p>
        <div className="flex mb"><input className="input" type="month" value={month} onChange={(e) => { setMonth(e.target.value); setSelected(null); }} /><button className="btn primary" onClick={() => close.mutate()} disabled={close.isPending}>Fechar mês</button></div>
        <button className={`btn block ${!selected ? 'navy' : ''}`} onClick={() => setSelected(null)}>Prévia de {monthLabel(month)}</button>
        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
          <table className="table mt"><tbody>{list.data!.map((c) => <tr key={c.id} className="row-link" onClick={() => setSelected(c.id)} style={{ background: selected === c.id ? 'var(--blue-100)' : undefined }}><td>{monthLabel(c.referenceMonth)}</td><td>v{c.version} {c.automatic && <Badge tone="info">automático</Badge>}</td><td className="small muted">{dateTimeBR(c.referenceDate)}</td></tr>)}</tbody></table>
        )}
      </div>
      <div className="card">
        <div className="card-header"><h3>{current ? monthLabel(current.month) : 'Relatório'} {current?.version && `— versão ${current.version}`}</h3>{selected && can('data.export') && <span className="flex"><button className="btn sm" onClick={() => openFile(`/api/reports/monthly/${selected}/pdf`)}>PDF</button><button className="btn sm" onClick={() => downloadFile(`/api/reports/monthly/${selected}/xlsx`, `relatorio-${current?.month}.xlsx`)}>Excel</button></span>}</div>
        {(preview.isLoading || detail.isLoading) ? <Loading /> : current ? <ReportView r={current} /> : <ErrorState error={preview.error ?? detail.error} />}
      </div>
    </div>
  );
}

function ReceiptsTab() {
  const { can } = useAuth();
  const [f, setF] = useState({ from: todayISO().slice(0, 8) + '01', to: todayISO(), clientId: '', userId: '' });
  const clients = useQuery({ queryKey: ['clients', ''], queryFn: () => api<Client[]>('clients') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<Array<{ id: string; name: string }>>('users'), enabled: can('users.manage') });
  const qs = `from=${f.from}&to=${f.to}&clientId=${f.clientId}&userId=${f.userId}`;
  const q = useQuery({ queryKey: ['reports', 'receipts', qs], queryFn: () => api<Array<{ id: string; paidAt: string; client: string; loan: number; installment: number; amount: string; principal: string; interest: string; charges: string; discount: string; method: string; status: string; receivedBy: string | null; receiptNumber: number | null }>>(`reports/receipts?${qs}`) });
  const confirmed = q.data?.filter((r) => r.status === 'CONFIRMED') ?? [];
  const sum = (k: 'amount' | 'principal' | 'interest' | 'charges') => confirmed.reduce((a, r) => a + Number(r[k]), 0);
  return (
    <div className="card">
      <div className="toolbar">
        <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <select className="input" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}><option value="">Todos os clientes</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {users.data && <select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">Todos os responsáveis</option>{users.data.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        {can('data.export') && <button className="btn" onClick={() => downloadFile(`/api/reports/receipts?${qs}&format=xlsx`, 'recebimentos.xlsx')}>Exportar Excel</button>}
      </div>
      <div className="grid cols-4 mb"><Stat label="Recebido" value={brl(sum('amount'))} /><Stat label="Principal" value={brl(sum('principal'))} /><Stat label="Juros" value={brl(sum('interest'))} /><Stat label="Encargos" value={brl(sum('charges'))} /></div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
        <DataTable rows={q.data!} emptyTitle="Nenhum recebimento com estes filtros" cardTitle={(r) => `${r.client} · ${brl(r.amount)}`} columns={[
          { key: 'paidAt', label: 'Data', render: (r) => dateBR(r.paidAt), sortValue: (r) => r.paidAt }, { key: 'client', label: 'Cliente', sortValue: (r) => r.client }, { key: 'loan', label: 'Contr./Parc.', render: (r) => `${r.loan}/${r.installment}` },
          { key: 'amount', label: 'Valor', num: true, render: (r) => brl(r.amount) }, { key: 'principal', label: 'Principal', num: true, render: (r) => brl(r.principal) }, { key: 'interest', label: 'Juros', num: true, render: (r) => brl(r.interest) }, { key: 'charges', label: 'Encargos', num: true, render: (r) => brl(r.charges) },
          { key: 'status', label: 'Situação', render: (r) => r.status === 'CONFIRMED' ? 'Confirmado' : r.status === 'REVERSED' ? 'Estornado' : r.status }, { key: 'receivedBy', label: 'Responsável' }, { key: 'receiptNumber', label: 'Recibo' },
        ]} />
      )}
    </div>
  );
}

function ExpensesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [from, setFrom] = useState(todayISO().slice(0, 8) + '01');
  const [to, setTo] = useState(todayISO());
  const [form, setForm] = useState({ date: todayISO(), description: '', category: 'GERAL', amount: '' });
  const q = useQuery({ queryKey: ['expenses', from, to], queryFn: () => api<Array<{ id: string; date: string; description: string; category: string; amount: string }>>(`reports/expenses?from=${from}&to=${to}`) });
  const add = useMutation({ mutationFn: () => api('reports/expenses', { body: form }), onSuccess: () => { toast('Despesa registrada', 'success'); setForm({ ...form, description: '', amount: '' }); qc.invalidateQueries({ queryKey: ['expenses'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const del = useMutation({ mutationFn: (id: string) => api(`reports/expenses/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }) });
  return (
    <div className="grid cols-2">
      {can('payments.register') && <div className="card"><h3>Nova despesa</h3><div className="form-row"><Field label="Data"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field><Field label="Valor (R$)"><input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field></div><Field label="Descrição"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field><Field label="Categoria"><input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field><button className="btn primary" onClick={() => add.mutate()} disabled={add.isPending}>Registrar</button></div>}
      <div className="card">
        <div className="toolbar"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : <DataTable rows={q.data!} emptyTitle="Nenhuma despesa no período" columns={[{ key: 'date', label: 'Data', render: (e) => dateBR(e.date) }, { key: 'description', label: 'Descrição' }, { key: 'category', label: 'Categoria' }, { key: 'amount', label: 'Valor', num: true, render: (e) => brl(e.amount) }, { key: 'act', label: '', render: (e) => can('payments.register') && <button className="btn sm" onClick={() => del.mutate(e.id)}>Excluir</button> }]} />}
        <KV items={[['Total do período', brl((q.data ?? []).reduce((a, e) => a + Number(e.amount), 0))]]} />
      </div>
    </div>
  );
}
