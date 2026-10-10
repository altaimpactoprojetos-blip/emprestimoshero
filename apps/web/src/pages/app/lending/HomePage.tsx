import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../../lib/api';
import { brl, dateBR } from '../../../lib/format';
import type { Client, DueItem, LendingDashboard } from '../../../lib/types';
import { useAuth } from '../../../auth/AuthContext';
import { Loading, ErrorState } from '../../../components/ui';
import { BigCard, StatusPill } from '../../../components/lending';
import { openWhatsApp } from '../../../lib/share';

function DueList({ items, empty, status }: { items: DueItem[]; empty: string; status: string }) {
  const nav = useNavigate();
  if (!items.length) return <div className="list"><div className="list-empty">{empty}</div></div>;
  return (
    <div className="list">
      {items.slice(0, 30).map((i) => (
        <div key={`${i.kind}-${i.loanId}-${i.dueDate}-${i.clientName}`} className="list-item link" onClick={() => nav(`/app/emprestimos/${i.loanId}`)}>
          <div className="main-col">
            <div className="title">{i.clientName}</div>
            <div className="meta">{i.daysLate > 0 ? `Venceu em ${dateBR(i.dueDate)} · ${i.daysLate} dia(s) de atraso` : `Vence em ${dateBR(i.dueDate)}`} · nº {i.number}</div>
          </div>
          <div className="right">
            <div className="amt">{brl(i.amount)}</div>
            <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
              <StatusPill status={status} />
              {i.clientPhone && <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); openWhatsApp(`Olá, ${i.clientName.split(' ')[0]}! Lembrete: ${i.daysLate > 0 ? `o pagamento de ${brl(i.amount)} venceu em ${dateBR(i.dueDate)}` : `o pagamento de ${brl(i.amount)} vence em ${dateBR(i.dueDate)}`}.`, i.clientPhone); }} aria-label="Cobrar pelo WhatsApp">WhatsApp</button>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomePage() {
  const nav = useNavigate();
  const { user, can } = useAuth();
  const [clientId, setClientId] = useState('');
  const clients = useQuery({ queryKey: ['clients', 'all'], queryFn: () => api<Client[]>('clients') });
  const q = useQuery({ queryKey: ['lending-dashboard', clientId], queryFn: () => api<LendingDashboard>(`lending/dashboard${clientId ? `?clientId=${clientId}` : ''}`) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={q.refetch} />;
  const d = q.data;
  const t = d.totals;
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <div><h1>Olá{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</h1><p className="muted small">Posição em {dateBR(d.today)}</p></div>
        {can('loans.create') && <button className="btn primary" onClick={() => nav('/app/emprestimos/novo')}>+ Novo empréstimo</button>}
      </div>
      <select className="input mb" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Filtrar por cliente" style={{ maxWidth: 360 }}>
        <option value="">Todos os clientes</option>
        {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <div className="big-cards">
        <BigCard tone="primary" label="Total na rua" value={brl(t.outstanding)} hint="Saldo devedor de todos os empréstimos" onClick={() => nav('/app/emprestimos')} />
        <BigCard label="Juros a receber" value={brl(t.interestToReceive)} hint="Pendentes + previstos até o vencimento" />
        <BigCard tone="success" label="Recebido no mês" value={brl(t.receivedMonth)} />
        <BigCard tone={Number(t.overdueAmount) > 0 ? 'danger' : undefined} label="Atrasados" value={brl(t.overdueAmount)} hint={`${t.overdueClients} cliente(s)`} onClick={() => nav('/app/emprestimos?status=OVERDUE')} />
      </div>
      <div className="list">
        <div className="list-item"><span className="muted">Total emprestado</span><span className="amt">{brl(t.lent)}</span></div>
        <div className="list-item"><span className="muted">Total recebido</span><span className="amt">{brl(t.received)}</span></div>
        <div className="list-item"><span className="muted">Juros já recebidos</span><span className="amt" style={{ color: 'var(--success)' }}>{brl(t.interestReceived)}</span></div>
      </div>
      <div className="chips mt">
        <Link className="chip" to="/app/emprestimos?status=ON_TIME"><span className="st-ON_TIME" style={{ color: 'var(--st)' }}>●</span> Em dia: {d.statusCount.ON_TIME ?? 0}</Link>
        <Link className="chip" to="/app/emprestimos?status=DUE_SOON"><span className="st-DUE_TODAY" style={{ color: 'var(--st)' }}>●</span> Vencem em breve: {(d.statusCount.DUE_TODAY ?? 0) + (d.statusCount.DUE_THIS_WEEK ?? 0)}</Link>
        <Link className="chip" to="/app/emprestimos?status=OVERDUE"><span className="st-OVERDUE" style={{ color: 'var(--st)' }}>●</span> Atrasados: {d.statusCount.OVERDUE ?? 0}</Link>
        <Link className="chip" to="/app/emprestimos?status=PAID"><span className="st-PAID" style={{ color: 'var(--st)' }}>●</span> Quitados: {d.statusCount.PAID ?? 0}</Link>
      </div>
      <div className="section-title"><h2>Atrasados</h2><span className="muted small">{d.overdue.length}</span></div>
      <DueList items={d.overdue} status="OVERDUE" empty="Nenhum pagamento atrasado." />
      <div className="section-title"><h2>Vencem hoje</h2><span className="muted small">{d.dueToday.length}</span></div>
      <DueList items={d.dueToday} status="DUE_TODAY" empty="Nada vence hoje." />
      <div className="section-title"><h2>Vencem nesta semana</h2><span className="muted small">{d.dueWeek.length}</span></div>
      <DueList items={d.dueWeek} status="DUE_THIS_WEEK" empty="Nada vence nos próximos 7 dias." />
      <div className="flex mt" style={{ marginTop: 20 }}>
        <button className="btn" onClick={() => nav('/app/simulador')}>Simulador</button>
        {can('reports.view') && <button className="btn" onClick={() => nav('/app/relatorios')}>Relatórios</button>}
      </div>
    </>
  );
}
