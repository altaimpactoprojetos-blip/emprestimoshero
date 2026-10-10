import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../../lib/api';
import { brl, dateBR } from '../../../lib/format';
import { BILLING_TYPE } from '../../../lib/labels';
import type { BalanceLoanCard, Loan } from '../../../lib/types';
import { useAuth } from '../../../auth/AuthContext';
import { Loading, ErrorState, EmptyState } from '../../../components/ui';
import { Progress, StatusPill } from '../../../components/lending';

const FILTERS: Array<{ key: string; label: string }> = [
  { key: '', label: 'Todos' }, { key: 'ON_TIME', label: 'Em dia' }, { key: 'DUE_SOON', label: 'Vencem em breve' }, { key: 'OVERDUE', label: 'Atrasados' }, { key: 'PAID', label: 'Quitados' },
];
const matches = (status: string, f: string) => !f || status === f || (f === 'DUE_SOON' && (status === 'DUE_TODAY' || status === 'DUE_THIS_WEEK'));

export function LoanCard({ l }: { l: BalanceLoanCard }) {
  const nav = useNavigate();
  const s = l.summary;
  return (
    <div className={`loan-card st-${s.status}`} onClick={() => nav(`/app/emprestimos/${l.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/app/emprestimos/${l.id}`)}>
      <div className="row1">
        <div><div className="name">{l.client.name}</div><div className="sub">Nº {l.number} · {BILLING_TYPE[l.billingType]?.label} · {brl(s.principal)}</div></div>
        <StatusPill status={s.status} />
      </div>
      <div className="amount">{brl(s.balance)}<small>saldo devedor</small></div>
      <div className="next">
        {s.status === 'PAID' ? <span>Quitado</span> : s.status === 'OVERDUE' ? <span style={{ color: 'var(--danger)' }}><strong style={{ color: 'inherit' }}>{brl(s.overdueAmount)}</strong> em atraso há {s.daysLate} dia(s)</span> : s.nextDue ? <span>Próximo vencimento: <strong>{dateBR(s.nextDue.date)}</strong></span> : <span />}
        {s.nextDue && s.status !== 'PAID' && <strong>{brl(s.nextDue.amount)}</strong>}
      </div>
      <Progress value={s.progress} status={s.status} labels={[`Pago ${brl(s.totalPaid)}`, `${s.progress.toLocaleString('pt-BR')}%`]} />
    </div>
  );
}

export function LoansListPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const filter = params.get('status') ?? '';
  const loans = useQuery({ queryKey: ['lending-loans'], queryFn: () => api<BalanceLoanCard[]>('lending/loans') });
  const legacy = useQuery({ queryKey: ['loans', 'legacy-count'], queryFn: () => api<Loan[]>('loans?status=DRAFT,UNDER_REVIEW,APPROVED,AWAITING_SIGNATURE,SIGNED,ACTIVE') });
  const legacyCount = legacy.data?.filter((l) => (l as unknown as { engine?: string }).engine !== 'BALANCE').length ?? 0;
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (loans.data ?? []).filter((l) => matches(l.summary.status, filter) && (!n || l.client.name.toLowerCase().includes(n)));
  }, [loans.data, q, filter]);
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h1>Empréstimos</h1>
        {can('loans.create') && <button className="btn primary" onClick={() => nav('/app/emprestimos/novo')}>+ Novo</button>}
      </div>
      <div className="search-bar"><input placeholder="Buscar pelo nome do cliente" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar pelo nome do cliente" /></div>
      <div className="chips">
        {FILTERS.map((f) => {
          const count = (loans.data ?? []).filter((l) => matches(l.summary.status, f.key)).length;
          return <button key={f.key} className={`chip ${filter === f.key ? 'active' : ''}`} onClick={() => setParams(f.key ? { status: f.key } : {})}>{f.label} ({count})</button>;
        })}
      </div>
      {loans.isLoading ? <Loading /> : loans.error ? <ErrorState error={loans.error} retry={loans.refetch} /> : rows.length === 0 ? (
        <div className="card"><EmptyState title={q || filter ? 'Nenhum empréstimo encontrado' : 'Nenhum empréstimo ainda'} text={q || filter ? 'Tente outro nome ou filtro.' : 'Toque em “+ Novo” para cadastrar o primeiro.'} /></div>
      ) : (
        <div className="loan-list">{rows.map((l) => <LoanCard key={l.id} l={l} />)}</div>
      )}
      <div className="flex mt" style={{ marginTop: 20 }}>
        <button className="btn" onClick={() => nav('/app/simulador')}>Simulador</button>
        {legacyCount > 0 && <Link className="btn" to="/app/emprestimos/parcelados">Empréstimos com parcelas pré-calculadas ({legacyCount})</Link>}
      </div>
    </>
  );
}
