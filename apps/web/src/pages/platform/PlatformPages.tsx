import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { brl, dateBR, dateTimeBR, currentMonthKey, maskDocument } from '../../lib/format';
import { COMPANY_STATUS, INVOICE_STATUS, ROLE } from '../../lib/labels';
import { PageHeader, Stat, Loading, ErrorState, DataTable, Modal, Field, StatusBadge, useForm, useToast, errorMessage, KV, Badge } from '../../components/ui';

interface Plan { id: string; name: string; description: string | null; monthlyPrice: string; maxUsers: number; maxClients: number | null; features: Record<string, boolean>; active: boolean; _count?: { companies: number } }
interface Company { id: string; name: string; slug: string; cnpj: string | null; status: string; plan: Plan | null; createdAt: string; _count: { users: number; clients: number; loans: number }; subscriptions: Array<{ status: string; monthlyPrice: string }> }

export function PlatformOverview() {
  const q = useQuery({ queryKey: ['platform', 'overview'], queryFn: () => api<Record<string, never>>('platform/overview') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const d = q.data as unknown as { companies: number; activeCompanies: number; plans: number; mrr: string; openInvoices: { count: number; amount: string }; overdueInvoices: { count: number; amount: string }; paidThisMonth: string };
  return (
    <>
      <PageHeader title="Visão geral da plataforma" subtitle="Financeiro das assinaturas do software, separado das operações de crédito das empresas." />
      <div className="grid cols-4">
        <Stat label="Empresas cadastradas" value={d.companies} hint={`${d.activeCompanies} ativa(s)`} />
        <Stat label="Receita mensal recorrente" value={brl(d.mrr)} hint="Soma das mensalidades ativas" />
        <Stat label="Faturas em aberto" value={brl(d.openInvoices.amount)} hint={`${d.openInvoices.count} fatura(s)`} />
        <Stat label="Faturas vencidas" value={brl(d.overdueInvoices.amount)} hint={`${d.overdueInvoices.count} fatura(s)`} tone={d.overdueInvoices.count ? 'danger' : ''} />
      </div>
      <div className="grid cols-2 mt">
        <Stat label="Recebido neste mês" value={brl(d.paidThisMonth)} tone="success" />
        <Stat label="Planos ativos" value={d.plans} />
      </div>
    </>
  );
}

const emptyCompany = { name: '', slug: '', legalName: '', cnpj: '', email: '', phone: '', planId: '', status: 'TRIAL', adminName: '', adminEmail: '', adminPassword: '' };

export function PlatformCompanies() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform', 'companies'], queryFn: () => api<Company[]>('platform/companies') });
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api<Plan[]>('platform/plans') });
  const [open, setOpen] = useState(false);
  const f = useForm(emptyCompany);
  const create = useMutation({
    mutationFn: () => api('platform/companies', { body: { name: f.values.name, slug: f.values.slug, legalName: f.values.legalName || null, cnpj: f.values.cnpj || null, email: f.values.email || null, phone: f.values.phone || null, planId: f.values.planId || null, status: f.values.status, admin: f.values.adminEmail ? { name: f.values.adminName, email: f.values.adminEmail, password: f.values.adminPassword } : undefined } }),
    onSuccess: () => { toast('Empresa cadastrada', 'success'); setOpen(false); f.reset(); qc.invalidateQueries({ queryKey: ['platform'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  return (
    <>
      <PageHeader title="Empresas" subtitle="Cada empresa possui ambiente, equipe, clientes e dados isolados." actions={<button className="btn primary" onClick={() => setOpen(true)}>Nova empresa</button>} />
      <div className="card">
        <DataTable rows={q.data!} searchKeys={(r) => `${r.name} ${r.slug} ${r.cnpj ?? ''}`} onRowClick={(r) => nav(`/plataforma/empresas/${r.id}`)} cardTitle={(r) => r.name}
          columns={[
            { key: 'name', label: 'Empresa', sortValue: (r) => r.name, render: (r) => <><strong>{r.name}</strong><div className="small muted">/{r.slug}</div></> },
            { key: 'status', label: 'Situação', render: (r) => <StatusBadge map={COMPANY_STATUS} value={r.status} />, sortValue: (r) => r.status },
            { key: 'plan', label: 'Plano', render: (r) => r.plan?.name ?? '—', sortValue: (r) => r.plan?.name },
            { key: 'price', label: 'Mensalidade', num: true, render: (r) => brl(r.subscriptions[0]?.monthlyPrice ?? 0) },
            { key: 'users', label: 'Usuários', num: true, render: (r) => r._count.users },
            { key: 'clients', label: 'Clientes', num: true, render: (r) => r._count.clients },
            { key: 'loans', label: 'Empréstimos', num: true, render: (r) => r._count.loans },
            { key: 'createdAt', label: 'Cadastro', render: (r) => dateBR(r.createdAt), sortValue: (r) => r.createdAt },
          ]} />
      </div>
      {open && (
        <Modal title="Nova empresa" onClose={() => setOpen(false)}>
          <div className="form-row">
            <Field label="Nome fantasia"><input {...f.bind('name')} /></Field>
            <Field label="Identificador (URL do portal)" help="Somente letras minúsculas, números e hífen"><input {...f.bind('slug')} placeholder="ex.: credito-sul" /></Field>
            <Field label="Razão social"><input {...f.bind('legalName')} /></Field>
            <Field label="CNPJ"><input {...f.bind('cnpj')} /></Field>
            <Field label="E-mail"><input {...f.bind('email')} /></Field>
            <Field label="Telefone"><input {...f.bind('phone')} /></Field>
            <Field label="Plano"><select {...f.bind('planId')}><option value="">Sem plano</option>{plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name} — {brl(p.monthlyPrice)}</option>)}</select></Field>
            <Field label="Situação"><select {...f.bind('status')}>{Object.entries(COMPANY_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
          </div>
          <h3>Administrador inicial (opcional)</h3>
          <div className="form-row cols-3">
            <Field label="Nome"><input {...f.bind('adminName')} /></Field>
            <Field label="E-mail"><input {...f.bind('adminEmail')} /></Field>
            <Field label="Senha provisória"><input type="password" {...f.bind('adminPassword')} /></Field>
          </div>
          <div className="form-actions"><button className="btn" onClick={() => setOpen(false)}>Cancelar</button><button className="btn primary" disabled={create.isPending} onClick={() => create.mutate()}>Salvar</button></div>
        </Modal>
      )}
    </>
  );
}

export function PlatformCompanyDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform', 'company', id], queryFn: () => api<Company & { legalName: string | null; email: string | null; phone: string | null; users: Array<{ id: string; name: string; email: string; role: string; active: boolean; twoFactorEnabled: boolean; lastLoginAt: string | null }>; subscriptions: Array<{ id: string; status: string; monthlyPrice: string; maxUsers: number; plan: Plan; currentPeriodEnd: string }>; subscriptionInvoices: Array<{ id: string; referenceMonth: string; amount: string; dueDate: string; status: string; paidAt: string | null }> }>(`platform/companies/${id}`) });
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api<Plan[]>('platform/plans') });
  const [editing, setEditing] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const f = useForm({ name: '', status: '', planId: '', legalName: '', email: '', phone: '' });
  const a = useForm({ name: '', email: '', password: '' });
  const save = useMutation({
    mutationFn: () => api(`platform/companies/${id}`, { method: 'PUT', body: { name: f.values.name, status: f.values.status, planId: f.values.planId || null, legalName: f.values.legalName || null, email: f.values.email || null, phone: f.values.phone || null } }),
    onSuccess: () => { toast('Empresa atualizada', 'success'); setEditing(false); qc.invalidateQueries({ queryKey: ['platform'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const setAdmin = useMutation({
    mutationFn: () => api(`platform/companies/${id}/admin`, { body: a.values }),
    onSuccess: () => { toast('Administrador definido', 'success'); setAdminOpen(false); qc.invalidateQueries({ queryKey: ['platform'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const payInvoice = useMutation({ mutationFn: (invId: string) => api(`platform/invoices/${invId}/pay`, { method: 'POST', body: {} }), onSuccess: () => { toast('Fatura baixada', 'success'); qc.invalidateQueries({ queryKey: ['platform'] }); } });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={q.refetch} />;
  const c = q.data;
  const sub = c.subscriptions[0];
  return (
    <>
      <PageHeader title={c.name} subtitle={`Identificador: ${c.slug}`} actions={<><button className="btn" onClick={() => { f.setValues({ name: c.name, status: c.status, planId: c.plan?.id ?? '', legalName: c.legalName ?? '', email: c.email ?? '', phone: c.phone ?? '' }); setEditing(true); }}>Editar</button><button className="btn primary" onClick={() => setAdminOpen(true)}>Definir administrador</button></>} />
      <div className="grid cols-2">
        <div className="card"><h3>Dados</h3><KV items={[['Situação', <StatusBadge map={COMPANY_STATUS} value={c.status} />], ['Razão social', c.legalName], ['CNPJ', maskDocument(c.cnpj)], ['E-mail', c.email], ['Telefone', c.phone], ['Clientes', c._count.clients], ['Empréstimos', c._count.loans]]} /></div>
        <div className="card"><h3>Assinatura</h3>{sub ? <KV items={[['Plano', sub.plan.name], ['Mensalidade', brl(sub.monthlyPrice)], ['Limite de usuários', sub.maxUsers], ['Situação', sub.status], ['Período atual até', dateBR(sub.currentPeriodEnd)]]} /> : <p className="muted">Sem assinatura ativa.</p>}</div>
      </div>
      <div className="card">
        <h3>Equipe</h3>
        <DataTable rows={c.users} columns={[{ key: 'name', label: 'Nome' }, { key: 'email', label: 'E-mail' }, { key: 'role', label: 'Perfil', render: (u) => ROLE[u.role] }, { key: 'active', label: 'Ativo', render: (u) => (u.active ? 'Sim' : 'Não') }, { key: '2fa', label: '2FA', render: (u) => (u.twoFactorEnabled ? 'Ativo' : '—') }, { key: 'last', label: 'Último acesso', render: (u) => dateTimeBR(u.lastLoginAt) }]} emptyTitle="Nenhum usuário" />
      </div>
      <div className="card">
        <h3>Faturas da assinatura</h3>
        <DataTable rows={c.subscriptionInvoices} columns={[{ key: 'referenceMonth', label: 'Referência' }, { key: 'amount', label: 'Valor', num: true, render: (i) => brl(i.amount) }, { key: 'dueDate', label: 'Vencimento', render: (i) => dateBR(i.dueDate) }, { key: 'status', label: 'Situação', render: (i) => <StatusBadge map={INVOICE_STATUS} value={i.status} /> }, { key: 'paidAt', label: 'Pago em', render: (i) => dateBR(i.paidAt) }, { key: 'act', label: '', render: (i) => (i.status === 'OPEN' || i.status === 'OVERDUE' ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); payInvoice.mutate(i.id); }}>Baixar</button> : null) }]} emptyTitle="Nenhuma fatura" />
      </div>
      {editing && (
        <Modal title="Editar empresa" onClose={() => setEditing(false)}>
          <div className="form-row">
            <Field label="Nome"><input {...f.bind('name')} /></Field>
            <Field label="Situação"><select {...f.bind('status')}>{Object.entries(COMPANY_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
            <Field label="Plano"><select {...f.bind('planId')}><option value="">Sem plano</option>{plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Razão social"><input {...f.bind('legalName')} /></Field>
            <Field label="E-mail"><input {...f.bind('email')} /></Field>
            <Field label="Telefone"><input {...f.bind('phone')} /></Field>
          </div>
          <div className="form-actions"><button className="btn" onClick={() => setEditing(false)}>Cancelar</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
        </Modal>
      )}
      {adminOpen && (
        <Modal title="Definir administrador da empresa" onClose={() => setAdminOpen(false)}>
          <p className="muted">Cria ou redefine a senha do administrador. O usuário deverá trocar a senha no primeiro acesso.</p>
          <Field label="Nome"><input {...a.bind('name')} /></Field>
          <Field label="E-mail"><input {...a.bind('email')} /></Field>
          <Field label="Senha provisória"><input type="password" {...a.bind('password')} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setAdminOpen(false)}>Cancelar</button><button className="btn primary" disabled={setAdmin.isPending} onClick={() => setAdmin.mutate()}>Salvar</button></div>
        </Modal>
      )}
    </>
  );
}

export function PlatformPlans() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api<Plan[]>('platform/plans') });
  const [editing, setEditing] = useState<Plan | null | 'new'>(null);
  const f = useForm({ name: '', description: '', monthlyPrice: '', maxUsers: 5, maxClients: '', active: true, collections: true, reports: true, portal: true, signature: false });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.values.name, description: f.values.description || null, monthlyPrice: f.values.monthlyPrice, maxUsers: Number(f.values.maxUsers), maxClients: f.values.maxClients ? Number(f.values.maxClients) : null, active: f.values.active, features: { collections: f.values.collections, reports: f.values.reports, portal: f.values.portal, signature: f.values.signature } };
      return editing === 'new' ? api('platform/plans', { body }) : api(`platform/plans/${(editing as Plan).id}`, { method: 'PUT', body });
    },
    onSuccess: () => { toast('Plano salvo', 'success'); setEditing(null); qc.invalidateQueries({ queryKey: ['platform', 'plans'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const openEdit = (p: Plan | 'new') => {
    if (p === 'new') f.reset(); else f.setValues({ name: p.name, description: p.description ?? '', monthlyPrice: p.monthlyPrice, maxUsers: p.maxUsers, maxClients: p.maxClients ? String(p.maxClients) : '', active: p.active, collections: !!p.features.collections, reports: !!p.features.reports, portal: !!p.features.portal, signature: !!p.features.signature });
    setEditing(p);
  };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  return (
    <>
      <PageHeader title="Planos" subtitle="Mensalidades, limites de usuários e recursos contratados." actions={<button className="btn primary" onClick={() => openEdit('new')}>Novo plano</button>} />
      <div className="card">
        <DataTable rows={q.data!} onRowClick={openEdit} cardTitle={(p) => p.name} columns={[
          { key: 'name', label: 'Plano', render: (p) => <><strong>{p.name}</strong><div className="small muted">{p.description}</div></> },
          { key: 'monthlyPrice', label: 'Mensalidade', num: true, render: (p) => brl(p.monthlyPrice) },
          { key: 'maxUsers', label: 'Usuários', num: true },
          { key: 'features', label: 'Recursos', render: (p) => <span className="flex">{Object.entries(p.features).filter(([, v]) => v).map(([k]) => <Badge key={k} tone="info">{({ collections: 'Cobranças', reports: 'Relatórios', portal: 'Portal', signature: 'Assinatura eletrônica' } as Record<string, string>)[k] ?? k}</Badge>)}</span> },
          { key: 'companies', label: 'Empresas', num: true, render: (p) => p._count?.companies ?? 0 },
          { key: 'active', label: 'Ativo', render: (p) => (p.active ? 'Sim' : 'Não') },
        ]} />
      </div>
      {editing && (
        <Modal title={editing === 'new' ? 'Novo plano' : 'Editar plano'} onClose={() => setEditing(null)}>
          <div className="form-row">
            <Field label="Nome"><input {...f.bind('name')} /></Field>
            <Field label="Mensalidade (R$)"><input type="number" step="0.01" {...f.bind('monthlyPrice')} /></Field>
            <Field label="Limite de usuários"><input type="number" {...f.bind('maxUsers')} /></Field>
            <Field label="Limite de clientes (opcional)"><input type="number" {...f.bind('maxClients')} /></Field>
          </div>
          <Field label="Descrição"><input {...f.bind('description')} /></Field>
          <label className="check"><input type="checkbox" {...f.bindCheck('collections')} /> Cobranças automáticas</label>
          <label className="check"><input type="checkbox" {...f.bindCheck('reports')} /> Relatórios mensais</label>
          <label className="check"><input type="checkbox" {...f.bindCheck('portal')} /> Portal do cliente</label>
          <label className="check"><input type="checkbox" {...f.bindCheck('signature')} /> Assinatura eletrônica</label>
          <label className="check"><input type="checkbox" {...f.bindCheck('active')} /> Plano ativo</label>
          <div className="form-actions"><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
        </Modal>
      )}
    </>
  );
}

export function PlatformInvoices() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['platform', 'invoices', status], queryFn: () => api<Array<{ id: string; referenceMonth: string; amount: string; dueDate: string; status: string; paidAt: string | null; company: { id: string; name: string } }>>(`platform/invoices${status ? `?status=${status}` : ''}`) });
  const [month, setMonth] = useState(currentMonthKey());
  const gen = useMutation({ mutationFn: () => api<{ created: number }>('platform/invoices/generate', { body: { referenceMonth: month } }), onSuccess: (r) => { toast(`${r.created} fatura(s) gerada(s)`, 'success'); qc.invalidateQueries({ queryKey: ['platform'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const pay = useMutation({ mutationFn: (id: string) => api(`platform/invoices/${id}/pay`, { method: 'POST', body: {} }), onSuccess: () => { toast('Fatura baixada', 'success'); qc.invalidateQueries({ queryKey: ['platform'] }); } });
  const cancel = useMutation({ mutationFn: (id: string) => api(`platform/invoices/${id}/cancel`, { method: 'POST', body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['platform'] }) });
  return (
    <>
      <PageHeader title="Faturas das assinaturas" subtitle="Cobrança das mensalidades do software às empresas." actions={<span className="flex"><input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /><button className="btn primary" onClick={() => gen.mutate()} disabled={gen.isPending}>Gerar faturas do mês</button></span>} />
      <div className="card">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : (
          <DataTable rows={q.data!} searchKeys={(i) => `${i.company.name} ${i.referenceMonth}`} cardTitle={(i) => i.company.name}
            filters={<select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas</option>{Object.entries(INVOICE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>}
            columns={[
              { key: 'company', label: 'Empresa', render: (i) => i.company.name, sortValue: (i) => i.company.name },
              { key: 'referenceMonth', label: 'Referência', sortValue: (i) => i.referenceMonth },
              { key: 'amount', label: 'Valor', num: true, render: (i) => brl(i.amount) },
              { key: 'dueDate', label: 'Vencimento', render: (i) => dateBR(i.dueDate), sortValue: (i) => i.dueDate },
              { key: 'status', label: 'Situação', render: (i) => <StatusBadge map={INVOICE_STATUS} value={i.status} /> },
              { key: 'paidAt', label: 'Pago em', render: (i) => dateBR(i.paidAt) },
              { key: 'act', label: '', render: (i) => (i.status === 'OPEN' || i.status === 'OVERDUE') ? <span className="flex"><button className="btn sm" onClick={() => pay.mutate(i.id)}>Baixar</button><button className="btn sm ghost" onClick={() => cancel.mutate(i.id)}>Cancelar</button></span> : null },
            ]} />
        )}
      </div>
    </>
  );
}
