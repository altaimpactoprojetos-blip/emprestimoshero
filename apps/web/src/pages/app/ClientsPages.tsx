import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, openFile } from '../../lib/api';
import { brl, dateBR, dateTimeBR, maskDocument, maskPhone } from '../../lib/format';
import { BILLING_TYPE, INSTALLMENT_STATUS, LOAN_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, REMINDER_STATUS, CHANNEL } from '../../lib/labels';
import type { Client, Loan, Payment } from '../../lib/types';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader, Loading, ErrorState, DataTable, Modal, Field, StatusBadge, useForm, useToast, errorMessage, KV, Badge, Tabs, Stat, EmptyState, Alert, Confirm } from '../../components/ui';
import { StatusPill } from '../../components/lending';
import { openWhatsApp } from '../../lib/share';

const emptyClient = { personType: 'PF', name: '', document: '', email: '', phone: '', birthDate: '', rg: '', nationality: 'brasileiro(a)', maritalStatus: '', profession: '', addressZip: '', addressStreet: '', addressNumber: '', addressComplement: '', addressDistrict: '', addressCity: '', addressState: '', notes: '', status: 'ACTIVE', prefEmail: true, prefSms: true, prefPortal: true };

export function ClientForm({ initial, onClose, onSaved }: { initial?: Client | null; onClose: () => void; onSaved: (c: Client) => void }) {
  const toast = useToast();
  const f = useForm(emptyClient);
  const [dup, setDup] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (initial) f.setValues({ personType: initial.personType, name: initial.name, document: maskDocument(initial.document), email: initial.email ?? '', phone: maskPhone(initial.phone), birthDate: initial.birthDate?.slice(0, 10) ?? '', rg: initial.rg ?? '', nationality: initial.nationality ?? '', maritalStatus: initial.maritalStatus ?? '', profession: initial.profession ?? '', addressZip: initial.addressZip ?? '', addressStreet: initial.addressStreet ?? '', addressNumber: initial.addressNumber ?? '', addressComplement: initial.addressComplement ?? '', addressDistrict: initial.addressDistrict ?? '', addressCity: initial.addressCity ?? '', addressState: initial.addressState ?? '', notes: initial.notes ?? '', status: initial.status, prefEmail: initial.contactPreferences?.email !== false, prefSms: initial.contactPreferences?.sms !== false, prefPortal: initial.contactPreferences?.portal !== false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const checkDup = async () => {
    const digits = f.values.document.replace(/\D/g, '');
    if (digits.length < 11 || (initial && digits === initial.document)) return setDup(null);
    const r = await api<{ exists: boolean; client: { id: string; name: string } | null }>(`clients/check-document?document=${digits}`);
    setDup(r.exists ? r.client : null);
  };
  const save = useMutation({
    mutationFn: () => {
      const v = f.values;
      const body = { personType: v.personType, name: v.name, document: v.document, email: v.email || null, phone: v.phone || null, birthDate: v.birthDate || null, rg: v.rg || null, nationality: v.nationality || null, maritalStatus: v.maritalStatus || null, profession: v.profession || null, addressZip: v.addressZip || null, addressStreet: v.addressStreet || null, addressNumber: v.addressNumber || null, addressComplement: v.addressComplement || null, addressDistrict: v.addressDistrict || null, addressCity: v.addressCity || null, addressState: v.addressState || null, notes: v.notes || null, status: v.status, contactPreferences: { email: v.prefEmail, sms: v.prefSms, portal: v.prefPortal } };
      return initial ? api<Client>(`clients/${initial.id}`, { method: 'PUT', body }) : api<Client>('clients', { body });
    },
    onSuccess: (c) => { toast('Cliente salvo', 'success'); onSaved(c); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal title={initial ? 'Editar cliente' : 'Novo cliente'} onClose={onClose} wide>
      {dup && <Alert kind="warning">Já existe um cliente com este documento nesta empresa: <Link to={`/app/clientes/${dup.id}`}>{dup.name}</Link></Alert>}
      <div className="form-row cols-3">
        <Field label="Tipo"><select {...f.bind('personType')}><option value="PF">Pessoa física</option><option value="PJ">Pessoa jurídica</option></select></Field>
        <Field label={f.values.personType === 'PJ' ? 'CNPJ' : 'CPF'}><input {...f.bind('document')} onBlur={checkDup} /></Field>
        <Field label="Situação"><select {...f.bind('status')}><option value="ACTIVE">Ativo</option><option value="BLOCKED">Bloqueado</option><option value="INACTIVE">Inativo</option></select></Field>
      </div>
      <Field label={f.values.personType === 'PJ' ? 'Razão social' : 'Nome completo'}><input {...f.bind('name')} /></Field>
      <div className="form-row cols-3">
        <Field label="Telefone celular (WhatsApp)"><input type="tel" {...f.bind('phone')} placeholder="(11) 99999-9999" /></Field>
        <Field label="E-mail (opcional)"><input type="email" {...f.bind('email')} /></Field>
        <Field label={f.values.personType === 'PJ' ? 'Data de fundação' : 'Data de nascimento'}><input type="date" {...f.bind('birthDate')} /></Field>
      </div>
      {f.values.personType === 'PF' && (
        <div className="form-row cols-4">
          <Field label="RG"><input {...f.bind('rg')} /></Field>
          <Field label="Nacionalidade"><input {...f.bind('nationality')} /></Field>
          <Field label="Estado civil"><select {...f.bind('maritalStatus')}><option value="">Selecione...</option>{['solteiro(a)', 'casado(a)', 'divorciado(a)', 'viúvo(a)', 'união estável'].map((o) => <option key={o} value={o}>{o}</option>)}</select></Field>
          <Field label="Profissão"><input {...f.bind('profession')} /></Field>
        </div>
      )}
      <h3>Endereço</h3>
      <div className="form-row cols-4">
        <Field label="CEP"><input {...f.bind('addressZip')} /></Field>
        <Field label="Logradouro"><input {...f.bind('addressStreet')} /></Field>
        <Field label="Número"><input {...f.bind('addressNumber')} /></Field>
        <Field label="Complemento"><input {...f.bind('addressComplement')} /></Field>
        <Field label="Bairro"><input {...f.bind('addressDistrict')} /></Field>
        <Field label="Cidade"><input {...f.bind('addressCity')} /></Field>
        <Field label="UF"><input maxLength={2} {...f.bind('addressState')} /></Field>
      </div>
      <Field label="Observações"><textarea {...f.bind('notes')} /></Field>
      <details><summary className="small" style={{ cursor: 'pointer', color: 'var(--brand-secondary)' }}>Preferências de contato automático</summary>
      <div className="flex mt">
        <label className="check"><input type="checkbox" {...f.bindCheck('prefEmail')} /> E-mail</label>
        <label className="check"><input type="checkbox" {...f.bindCheck('prefSms')} /> SMS</label>
        <label className="check"><input type="checkbox" {...f.bindCheck('prefPortal')} /> Avisos no portal</label>
      </div></details>
      <div className="form-actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={save.isPending || !!dup} onClick={() => save.mutate()}>{save.isPending ? 'Salvando...' : 'Salvar'}</button></div>
    </Modal>
  );
}

export function ClientsPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['clients', status], queryFn: () => api<Client[]>(`clients?status=${status}`) });
  const n = search.trim().toLowerCase();
  const digits = search.replace(/\D/g, '');
  const rows = (q.data ?? []).filter((c) => !n || c.name.toLowerCase().includes(n) || (digits.length >= 3 && (c.document.includes(digits) || (c.phone ?? '').includes(digits))));
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h1>Clientes</h1>
        {can('clients.manage') && <button className="btn primary" onClick={() => setOpen(true)}>+ Novo</button>}
      </div>
      <div className="search-bar"><input placeholder="Buscar pelo nome do cliente" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar pelo nome do cliente" /></div>
      <div className="chips">
        {[['', 'Todos'], ['ACTIVE', 'Ativos'], ['BLOCKED', 'Bloqueados'], ['INACTIVE', 'Inativos']].map(([k, l]) => <button key={k} className={`chip ${status === k ? 'active' : ''}`} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : rows.length === 0 ? (
        <div className="card"><EmptyState title={search ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'} text={search ? 'Tente outro nome.' : 'Toque em “+ Novo” para cadastrar o primeiro cliente.'} /></div>
      ) : (
        <div className="list">
          {rows.map((c) => {
            const overdue = Number(c.summary?.overdueBalance) > 0;
            return (
              <div key={c.id} className="list-item link" onClick={() => nav(`/app/clientes/${c.id}`)}>
                <div className="main-col">
                  <div className="title">{c.name} {c.status !== 'ACTIVE' && <Badge tone={c.status === 'BLOCKED' ? 'danger' : 'neutral'}>{c.status === 'BLOCKED' ? 'Bloqueado' : 'Inativo'}</Badge>}</div>
                  <div className="meta">{maskPhone(c.phone) || maskDocument(c.document)} · {c.summary?.loans ?? 0} empréstimo(s)</div>
                </div>
                <div className="right">
                  <div className="amt">{brl(c.summary?.openBalance)}</div>
                  {overdue ? <span className="st-pill st-OVERDUE">Atrasado {c.summary?.maxDaysLate} d</span> : Number(c.summary?.openBalance) > 0 ? <span className="st-pill st-ON_TIME">Em dia</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {open && <ClientForm onClose={() => setOpen(false)} onSaved={(c) => { setOpen(false); qc.invalidateQueries({ queryKey: ['clients'] }); nav(`/app/clientes/${c.id}`); }} />}
    </>
  );
}

interface ClientDetail extends Client {
  documents: Array<{ id: string; type: string; createdAt: string; file: { id: string; filename: string; mimeType: string; size: number } }>;
  user: { id: string; email: string; active: boolean; lastLoginAt: string | null } | null;
  loans: Loan[];
  payments: Payment[];
  serviceRequests: Array<{ id: string; type: string; message: string; status: string; response: string | null; createdAt: string; loanId: string | null }>;
  reminders: Array<{ id: string; channel: string; offsetDays: number; status: string; scheduledFor: string; sentAt: string | null; renderedSubject: string | null; renderedBody: string | null; lastError: string | null; installment: { number: number; dueDate: string; loanId: string } }>;
  notifications: Array<{ id: string; title: string; body: string; createdAt: string; readAt: string | null }>;
  totals: { openBalance: string; overdueBalance: string; maxDaysLate: number; activeLoans: number; totalPaid: string };
}

const DOC_TYPES: Record<string, string> = { RG: 'RG', CPF: 'CPF', CNH: 'CNH', COMPROVANTE_RESIDENCIA: 'Comprovante de residência', COMPROVANTE_RENDA: 'Comprovante de renda', CONTRATO_SOCIAL: 'Contrato social', OUTRO: 'Outro' };
const SR_TYPE: Record<string, string> = { SUPPORT: 'Atendimento', RENEGOTIATION: 'Renegociação', DISPUTE: 'Contestação' };
const SR_STATUS: Record<string, { label: string; tone: string }> = { OPEN: { label: 'Aberta', tone: 'warning' }, IN_PROGRESS: { label: 'Em andamento', tone: 'info' }, CLOSED: { label: 'Concluída', tone: 'success' } };

export function ClientDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['client', id], queryFn: () => api<ClientDetail>(`clients/${id}`) });
  const [tab, setTab] = useState('emprestimos');
  const [editing, setEditing] = useState(false);
  const [docType, setDocType] = useState('OUTRO');
  const [portalOpen, setPortalOpen] = useState(false);
  const [portalPw, setPortalPw] = useState('');
  const [reply, setReply] = useState<{ id: string; status: string; response: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['client', id] });
  const remove = useMutation({ mutationFn: () => api(`clients/${id}`, { method: 'DELETE' }), onSuccess: () => { toast('Cliente excluído', 'success'); qc.invalidateQueries({ queryKey: ['clients'] }); nav('/app/clientes', { replace: true }); }, onError: (e) => { setDeleting(false); toast(errorMessage(e), 'error'); } });
  const upload = async (file: File) => {
    const fd = new FormData(); fd.append('file', file); fd.append('type', docType);
    try { await api(`clients/${id}/documents`, { formData: fd }); toast('Documento anexado', 'success'); refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const portal = useMutation({ mutationFn: () => api(`clients/${id}/portal-access`, { body: { password: portalPw } }), onSuccess: () => { toast('Acesso ao portal definido', 'success'); setPortalOpen(false); setPortalPw(''); refresh(); }, onError: (e) => toast(errorMessage(e), 'error') });
  const answer = useMutation({ mutationFn: () => api(`clients/${id}/service-requests/${reply!.id}`, { method: 'PUT', body: { status: reply!.status, response: reply!.response } }), onSuccess: () => { toast('Solicitação atualizada', 'success'); setReply(null); refresh(); }, onError: (e) => toast(errorMessage(e), 'error') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={q.refetch} />;
  const c = q.data;
  const allInstallments = c.loans.filter((l) => l.status === 'ACTIVE').flatMap((l) => l.installments.map((i) => ({ ...i, loanNumber: l.number })));
  return (
    <>
      <PageHeader title={c.name} subtitle={`${c.personType === 'PJ' ? 'CNPJ' : 'CPF'} ${maskDocument(c.document)} · Cliente desde ${dateBR(c.createdAt)}`}
        actions={<>
          {can('loans.create') && c.status === 'ACTIVE' && <button className="btn primary" onClick={() => nav(`/app/emprestimos/novo?clientId=${c.id}`)}>Novo empréstimo</button>}
          {can('clients.manage') && <button className="btn" onClick={() => setEditing(true)}>Editar cadastro</button>}
          {c.phone && <button className="btn success" onClick={() => openWhatsApp(`Olá, ${c.name.split(' ')[0]}!`, c.phone)}>WhatsApp</button>}
          {can('clients.manage') && <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => setDeleting(true)}>Excluir</button>}
          {can('clients.manage') && <button className="btn" onClick={() => setPortalOpen(true)}>{c.user ? 'Redefinir acesso ao portal' : 'Criar acesso ao portal'}</button>}
        </>} />
      <div className="grid cols-4">
        <Stat label="Saldo devedor" value={brl(c.totals.openBalance)} hint={`${c.totals.activeLoans} contrato(s) ativo(s)`} />
        <Stat label="Em atraso" value={brl(c.totals.overdueBalance)} hint={c.totals.maxDaysLate ? `${c.totals.maxDaysLate} dias de atraso` : 'Sem atrasos'} tone={Number(c.totals.overdueBalance) > 0 ? 'danger' : 'success'} />
        <Stat label="Total pago" value={brl(c.totals.totalPaid)} />
        <Stat label="Situação" value={<Badge tone={c.status === 'ACTIVE' ? 'success' : c.status === 'BLOCKED' ? 'danger' : 'neutral'}>{{ ACTIVE: 'Ativo', BLOCKED: 'Bloqueado', INACTIVE: 'Inativo' }[c.status]}</Badge>} hint={c.user ? `Portal: ${c.user.email}` : 'Sem acesso ao portal'} />
      </div>
      <div className="grid cols-2 mt">
        <div className="card">
          <h3>Dados cadastrais</h3>
          <KV items={[['Telefone', maskPhone(c.phone)], ['E-mail', c.email], ['RG', c.rg], ['Nacionalidade', c.nationality], ['Estado civil', c.maritalStatus], ['Profissão', c.profession], [c.personType === 'PJ' ? 'Fundação' : 'Nascimento', dateBR(c.birthDate)], ['Endereço', [c.addressStreet, c.addressNumber, c.addressComplement, c.addressDistrict, c.addressCity && `${c.addressCity}/${c.addressState}`, c.addressZip].filter(Boolean).join(', ') || null], ['Preferências de contato', ['email', 'sms', 'portal'].filter((k) => c.contactPreferences?.[k as 'email'] !== false).map((k) => CHANNEL[k.toUpperCase()]).join(', ')], ['Observações', c.notes]]} />
        </div>
        <div className="card">
          <div className="card-header"><h3>Documentos</h3>{can('clients.manage') && <span className="flex"><select className="input" value={docType} onChange={(e) => setDocType(e.target.value)}>{Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><label className="btn sm">Anexar<input type="file" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label></span>}</div>
          {c.documents.length === 0 ? <EmptyState title="Nenhum documento anexado" /> : (
            <table className="table"><tbody>{c.documents.map((d) => <tr key={d.id}><td>{DOC_TYPES[d.type] ?? d.type}</td><td>{d.file.filename}<div className="small muted">{dateBR(d.createdAt)} · {(d.file.size / 1024).toFixed(0)} KB</div></td><td className="right"><button className="btn sm" onClick={() => openFile(`/api/company/files/${d.file.id}`)}>Abrir</button></td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <div className="card">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'emprestimos', label: `Empréstimos (${c.loans.length})` }, { key: 'parcelas', label: `Parcelas (${allInstallments.length})` }, { key: 'pagamentos', label: `Pagamentos (${c.payments.length})` }, { key: 'comunicacoes', label: `Comunicações (${c.reminders.length})` }, { key: 'solicitacoes', label: `Solicitações (${c.serviceRequests.length})` }]} />
        {tab === 'emprestimos' && (
          <DataTable rows={c.loans} onRowClick={(l) => nav(`/app/emprestimos/${l.id}`)} emptyTitle="Nenhum empréstimo" cardTitle={(l) => `Empréstimo nº ${l.number}`} columns={[
            { key: 'number', label: 'Nº', render: (l) => <strong>{l.number}</strong>, sortValue: (l) => l.number },
            { key: 'status', label: 'Situação', render: (l) => (l.ledgerStatus ? <StatusPill status={l.ledgerStatus} /> : <StatusBadge map={LOAN_STATUS} value={l.status} />) },
            { key: 'principal', label: 'Valor emprestado', num: true, render: (l) => brl(l.principalAmount) },
            { key: 'parcelas', label: 'Condições', render: (l) => (l.engine === 'BALANCE' ? `${BILLING_TYPE[l.billingType ?? '']?.label ?? ''}${l.summary.nextDue ? ` · próximo ${dateBR(l.summary.nextDue.date)}` : ''}` : `${l.summary.paidInstallments ?? 0}/${l.installmentsCount} pagas · ${brl(l.installmentAmount)}`) },
            { key: 'open', label: 'Saldo devedor', num: true, render: (l) => brl(l.summary.openBalance) },
            { key: 'overdue', label: 'Em atraso', num: true, render: (l) => (Number(l.summary.overdueBalance) > 0 ? <span style={{ color: 'var(--danger)' }}>{brl(l.summary.overdueBalance)}</span> : '—') },
            { key: 'contracts', label: 'Contrato', render: (l) => (l.contracts.length ? <StatusBadge map={{ DRAFT: { label: 'Rascunho', tone: 'neutral' }, IN_REVIEW: { label: 'Em revisão', tone: 'info' }, AWAITING_SIGNATURE: { label: 'Aguardando assinatura', tone: 'warning' }, SIGNED: { label: 'Assinado', tone: 'success' }, CANCELLED: { label: 'Cancelado', tone: 'danger' } }} value={l.contracts[0].status} /> : '—') },
            { key: 'date', label: 'Liberação', render: (l) => dateBR(l.disbursedAt ?? l.disbursementDate) },
          ]} />
        )}
        {tab === 'parcelas' && (
          <DataTable rows={allInstallments} onRowClick={(i) => nav(`/app/emprestimos/${i.loanId}`)} emptyTitle="Nenhuma parcela ativa" cardTitle={(i) => `Empréstimo ${i.loanNumber} · Parcela ${i.number}`} initialSort={{ key: 'due', dir: 'asc' }} columns={[
            { key: 'loan', label: 'Empréstimo', render: (i) => i.loanNumber },
            { key: 'number', label: 'Parcela', render: (i) => i.number },
            { key: 'due', label: 'Vencimento', render: (i) => dateBR(i.dueDate), sortValue: (i) => i.dueDate },
            { key: 'orig', label: 'Valor original', num: true, render: (i) => brl(i.originalAmount) },
            { key: 'paid', label: 'Pago', num: true, render: (i) => brl(Number(i.paidPrincipal) + Number(i.paidInterest) + Number(i.paidCharges)) },
            { key: 'due_total', label: 'Saldo', num: true, render: (i) => brl(i.balance.totalDue) },
            { key: 'late', label: 'Atraso', render: (i) => (i.balance.daysLate ? `${i.balance.daysLate} d` : '—') },
            { key: 'status', label: 'Situação', render: (i) => <StatusBadge map={INSTALLMENT_STATUS} value={i.balance.displayStatus} /> },
          ]} />
        )}
        {tab === 'pagamentos' && (
          <DataTable rows={c.payments} emptyTitle="Nenhum pagamento registrado" cardTitle={(p) => `${brl(p.amount)} em ${dateBR(p.paidAt)}`} columns={[
            { key: 'paidAt', label: 'Data', render: (p) => dateBR(p.paidAt), sortValue: (p) => p.paidAt },
            { key: 'loan', label: 'Empréstimo', render: (p) => `${p.loan?.number}${p.installment ? ` / parcela ${p.installment.number}` : ''}` },
            { key: 'amount', label: 'Valor', num: true, render: (p) => brl(p.amount) },
            { key: 'alloc', label: 'Destinação', render: (p) => <span className="small">Principal {brl(p.principalPortion)} · Juros {brl(p.interestPortion)} · Encargos {brl(p.chargesPortion)}{Number(p.discountAmount) > 0 && ` · Desconto ${brl(p.discountAmount)}`}</span> },
            { key: 'method', label: 'Forma', render: (p) => PAYMENT_METHOD[p.method] },
            { key: 'status', label: 'Situação', render: (p) => <StatusBadge map={PAYMENT_STATUS} value={p.status} /> },
            { key: 'receipt', label: 'Recibo', render: (p) => (p.receiptNumber ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); openFile(`/api/payments/${p.id}/receipt`); }}>Nº {p.receiptNumber}</button> : '—') },
          ]} />
        )}
        {tab === 'comunicacoes' && (
          <DataTable rows={c.reminders} emptyTitle="Nenhuma comunicação registrada" cardTitle={(r) => `${CHANNEL[r.channel]} · parcela ${r.installment.number}`} columns={[
            { key: 'scheduledFor', label: 'Agendado para', render: (r) => dateTimeBR(r.scheduledFor), sortValue: (r) => r.scheduledFor },
            { key: 'channel', label: 'Canal', render: (r) => CHANNEL[r.channel] },
            { key: 'step', label: 'Etapa', render: (r) => (r.offsetDays < 0 ? `${-r.offsetDays} dias antes` : r.offsetDays === 0 ? 'No vencimento' : `${r.offsetDays} dias após`) },
            { key: 'inst', label: 'Parcela', render: (r) => `${r.installment.number} (${dateBR(r.installment.dueDate)})` },
            { key: 'status', label: 'Situação', render: (r) => <><StatusBadge map={REMINDER_STATUS} value={r.status} />{r.lastError && <div className="small muted">{r.lastError}</div>}</> },
            { key: 'sentAt', label: 'Enviado em', render: (r) => dateTimeBR(r.sentAt) },
          ]} />
        )}
        {tab === 'solicitacoes' && (
          <DataTable rows={c.serviceRequests} emptyTitle="Nenhuma solicitação do cliente" cardTitle={(s) => SR_TYPE[s.type]} columns={[
            { key: 'createdAt', label: 'Data', render: (s) => dateTimeBR(s.createdAt) },
            { key: 'type', label: 'Tipo', render: (s) => SR_TYPE[s.type] ?? s.type },
            { key: 'message', label: 'Mensagem', render: (s) => <div style={{ maxWidth: 360, whiteSpace: 'pre-wrap' }}>{s.message}{s.response && <div className="small muted">Resposta: {s.response}</div>}</div> },
            { key: 'status', label: 'Situação', render: (s) => <StatusBadge map={SR_STATUS} value={s.status} /> },
            { key: 'act', label: '', render: (s) => can('clients.manage') && <button className="btn sm" onClick={() => setReply({ id: s.id, status: s.status === 'OPEN' ? 'IN_PROGRESS' : s.status, response: s.response ?? '' })}>Responder</button> },
          ]} />
        )}
      </div>
      {editing && <ClientForm initial={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {deleting && <Confirm danger title="Excluir cliente" confirmLabel="Excluir" busy={remove.isPending} text={c.loans.length ? <>Este cliente tem {c.loans.length} empréstimo(s). Exclua os empréstimos antes ou marque o cliente como inativo em “Editar cadastro”.</> : <>Excluir o cadastro de <strong>{c.name}</strong> e seus documentos? Esta ação não pode ser desfeita.</>} onCancel={() => setDeleting(false)} onConfirm={() => (c.loans.length ? setDeleting(false) : remove.mutate())} />}
      {portalOpen && (
        <Modal title="Acesso ao portal do cliente" onClose={() => setPortalOpen(false)}>
          <p className="muted">O cliente entra em <span className="mono">/portal/{'{empresa}'}</span> com CPF/CNPJ ou e-mail e a senha provisória abaixo, que deverá ser trocada no primeiro acesso.</p>
          <Field label="Senha provisória" help="Mínimo 8 caracteres, letras e números"><input type="text" value={portalPw} onChange={(e) => setPortalPw(e.target.value)} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setPortalOpen(false)}>Cancelar</button><button className="btn primary" disabled={portal.isPending} onClick={() => portal.mutate()}>Salvar</button></div>
        </Modal>
      )}
      {reply && (
        <Modal title="Responder solicitação" onClose={() => setReply(null)}>
          <Field label="Situação"><select value={reply.status} onChange={(e) => setReply({ ...reply, status: e.target.value })}><option value="OPEN">Aberta</option><option value="IN_PROGRESS">Em andamento</option><option value="CLOSED">Concluída</option></select></Field>
          <Field label="Resposta ao cliente (visível no portal)"><textarea value={reply.response} onChange={(e) => setReply({ ...reply, response: e.target.value })} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setReply(null)}>Cancelar</button><button className="btn primary" disabled={answer.isPending} onClick={() => answer.mutate()}>Salvar</button></div>
        </Modal>
      )}
    </>
  );
}
