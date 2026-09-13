import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dateTimeBR } from '../../lib/format';
import { PageHeader, Loading, ErrorState, EmptyState } from '../../components/ui';

interface Log { id: string; action: string; entity: string; entityId: string | null; userName: string | null; before: unknown; after: unknown; ip: string | null; createdAt: string }

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [entity, setEntity] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['audit', page, q, entity], queryFn: () => api<{ items: Log[]; total: number; pageSize: number }>(`audit?page=${page}&q=${encodeURIComponent(q)}&entity=${entity}`) });
  return (
    <>
      <PageHeader title="Registro de ações" subtitle="Quem fez o quê e quando, com os dados antes e depois da alteração." />
      <div className="card">
        <div className="toolbar">
          <input className="input" placeholder="Filtrar por ação (ex.: PAYMENT)" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <select className="input" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }}>
            <option value="">Todas as entidades</option>
            {['Client', 'Loan', 'Installment', 'Payment', 'Contract', 'ContractTemplate', 'User', 'Company', 'Reminder', 'CollectionSettings', 'Charge', 'Renegotiation', 'MonthlyReport'].map((e) => <option key={e}>{e}</option>)}
          </select>
        </div>
        {query.isLoading ? <Loading /> : query.error ? <ErrorState error={query.error} retry={query.refetch} /> : query.data!.items.length === 0 ? <EmptyState title="Nenhum registro encontrado" /> : (
          <>
            <div className="table-wrap"><table className="table"><thead><tr><th>Data/hora</th><th>Usuário</th><th>Ação</th><th>Entidade</th><th>IP</th><th></th></tr></thead><tbody>
              {query.data!.items.map((l) => (
                <>
                  <tr key={l.id}><td className="nowrap">{dateTimeBR(l.createdAt)}</td><td>{l.userName ?? 'Sistema'}</td><td className="mono">{l.action}</td><td>{l.entity}<div className="small muted mono">{l.entityId}</div></td><td className="mono">{l.ip}</td><td><button className="btn sm" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Ocultar' : 'Detalhes'}</button></td></tr>
                  {open === l.id && <tr key={l.id + 'd'}><td colSpan={6}><div className="grid cols-2"><div><strong>Antes</strong><pre className="code">{JSON.stringify(l.before, null, 2) ?? '—'}</pre></div><div><strong>Depois</strong><pre className="code">{JSON.stringify(l.after, null, 2) ?? '—'}</pre></div></div></td></tr>}
                </>
              ))}
            </tbody></table></div>
            <div className="pagination"><span>{query.data!.total} registro(s)</span><span className="flex"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><button className="btn sm" disabled={page * query.data!.pageSize >= query.data!.total} onClick={() => setPage(page + 1)}>Próxima</button></span></div>
          </>
        )}
      </div>
    </>
  );
}
