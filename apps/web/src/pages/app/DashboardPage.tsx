import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { brl, pct, todayISO } from '../../lib/format';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader, Loading, ErrorState, Stat, Alert } from '../../components/ui';

interface Dash { period: { from: string; to: string }; today: string; disbursed: { count: number; amount: string; principal: string }; received: { count: number; total: string; principal: string; interest: string; charges: string; discounts: string }; reversed: { count: number; amount: string }; expected: { count: number; amount: string }; openBalance: string; openPrincipal: string; overdue: { count: number; amount: string; clients: number; over30: string }; dueToday: { count: number; amount: string }; activeClients: number; indicators: { overdueRate: string; overdueClientsRate: string; overdue30Rate: string }; formulas: Record<string, string> }

const monthStart = () => todayISO().slice(0, 8) + '01';

export function DashboardPage() {
  const nav = useNavigate();
  const { can, user } = useAuth();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayISO());
  const q = useQuery({ queryKey: ['dashboard', from, to], queryFn: () => api<Dash>(`reports/dashboard?from=${from}&to=${to}`), enabled: can('reports.view') });
  if (!can('reports.view')) return <><PageHeader title="Painel" subtitle={user?.company?.name} /><div className="card"><div className="flex">{can('clients.manage') && <button className="btn primary" onClick={() => nav('/app/clientes')}>Cadastrar cliente</button>}{can('loans.create') && <button className="btn" onClick={() => nav('/app/emprestimos/novo')}>Simular empréstimo</button>}{can('payments.register') && <button className="btn" onClick={() => nav('/app/parcelas')}>Receber parcela</button>}{can('collections.manage') && <button className="btn" onClick={() => nav('/app/cobrancas')}>Acompanhar cobranças</button>}</div></div></>;
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={q.refetch} />;
  const d = q.data;
  return (
    <>
      <PageHeader title="Painel" subtitle={user?.company?.name} actions={<span className="flex"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></span>} />
      <div className="card compact">
        <div className="flex">
          <strong>Ações rápidas:</strong>
          {can('clients.manage') && <button className="btn primary sm" onClick={() => nav('/app/clientes')}>Cadastrar cliente</button>}
          {can('loans.create') && <button className="btn sm" onClick={() => nav('/app/emprestimos/novo')}>Simular empréstimo</button>}
          {can('contracts.manage') && <button className="btn sm" onClick={() => nav('/app/contratos')}>Emitir contrato</button>}
          {can('payments.register') && <button className="btn sm" onClick={() => nav('/app/parcelas')}>Receber parcela</button>}
          {can('collections.manage') && <button className="btn sm" onClick={() => nav('/app/cobrancas')}>Acompanhar cobranças</button>}
        </div>
      </div>
      <h3 className="mb">Período selecionado</h3>
      <div className="grid cols-4">
        <Stat label="Valor efetivamente emprestado" value={brl(d.disbursed.amount)} hint={`${d.disbursed.count} contrato(s) liberado(s) · principal ${brl(d.disbursed.principal)}`} />
        <Stat label="Principal recuperado" value={brl(d.received.principal)} hint="Devolução de capital — não é lucro" />
        <Stat label="Juros recebidos" value={brl(d.received.interest)} hint={`Encargos de atraso ${brl(d.received.charges)}`} tone="success" />
        <Stat label="Recebimentos realizados" value={brl(d.received.total)} hint={`${d.received.count} pagamento(s) · previstos no período ${brl(d.expected.amount)} (${d.expected.count} parcelas)`} />
      </div>
      <h3 className="mb mt">Posição atual ({d.today.split('-').reverse().join('/')})</h3>
      <div className="grid cols-4">
        <Stat label="Saldo a receber" value={brl(d.openBalance)} hint={`Principal em aberto ${brl(d.openPrincipal)}`} />
        <Stat label="Saldo vencido" value={brl(d.overdue.amount)} hint={`${d.overdue.count} parcela(s) · ${brl(d.overdue.over30)} com mais de 30 dias`} tone={d.overdue.count ? 'danger' : 'success'} />
        <Stat label="Parcelas de hoje" value={brl(d.dueToday.amount)} hint={`${d.dueToday.count} parcela(s)`} tone={d.dueToday.count ? 'warning' : ''} />
        <Stat label="Clientes em atraso" value={d.overdue.clients} hint={`de ${d.activeClients} cliente(s) com contrato ativo`} tone={d.overdue.clients ? 'danger' : 'success'} />
      </div>
      <div className="grid cols-3 mt">
        <Stat label="Inadimplência (valor)" value={pct(d.indicators.overdueRate)} hint={d.formulas.overdueRate} />
        <Stat label="Inadimplência (clientes)" value={pct(d.indicators.overdueClientsRate)} hint={d.formulas.overdueClientsRate} />
        <Stat label="Inadimplência 30+ dias" value={pct(d.indicators.overdue30Rate)} hint={d.formulas.overdue30Rate} />
      </div>
      {d.reversed.count > 0 && <Alert kind="warning">{d.reversed.count} estorno(s) no período, totalizando {brl(d.reversed.amount)}.</Alert>}
      {Number(d.received.discounts) > 0 && <p className="small muted mt">Descontos concedidos no período: {brl(d.received.discounts)}.</p>}
    </>
  );
}
