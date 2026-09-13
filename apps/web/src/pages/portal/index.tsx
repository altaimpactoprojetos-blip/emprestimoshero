import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Outlet, Route, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openFile } from '../../lib/api';
import { brl, dateBR, dateTimeBR, maskDocument, maskPhone, pct, todayISO } from '../../lib/format';
import { INSTALLMENT_STATUS, LOAN_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, PERIODICITY, CALC_METHOD } from '../../lib/labels';
import type { Installment } from '../../lib/types';
import { useAuth, type User } from '../../auth/AuthContext';
import { Field, Loading, ErrorState, StatusBadge, Stat, Alert, Modal, useToast, errorMessage, KV, EmptyState, Badge, DataTable } from '../../components/ui';

interface PortalLoan { id: string; number: number; status: string; principalAmount: string; disbursedAmount: string; installmentsCount: number; installmentAmount: string; periodicity: string; monthlyRate: string; cetAnnual: string; totalAmount: string; disbursedAt: string | null; firstDueDate: string; calcMethod: string; collectionState: string; contracts: Array<{ id: string; version: number; kind: string; status: string; signedAt: string | null }>; installments: Array<Installment & { charges: Array<{ id: string; type: string; amount: string; payload: Record<string, string> | null; expiresAt: string | null }> }>; summary: { openBalance: string; overdueBalance: string; overdueCount: number; paidCount: number; nextDue: { number: number; dueDate: string; amount: string } | null } }
interface PortalMe { client: { id: string; name: string; document: string; email: string | null; phone: string | null; contactPreferences: { email?: boolean; sms?: boolean; portal?: boolean } }; company: { id: string; name: string; slug: string; email: string | null; phone: string | null; logoFileId: string | null; primaryColor: string; secondaryColor: string; settings: { pixKey: string | null; paymentInstructions: string | null } }; loans: PortalLoan[]; unreadNotifications: number; totals: { openBalance: string; overdueBalance: string }; paymentsProvider: string; today: string }

function useCompanyBrand(slug?: string) {
  return useQuery({ queryKey: ['company-public', slug], queryFn: () => api<{ id: string; name: string; slug: string; logoFileId: string | null; primaryColor: string; secondaryColor: string }>(`company/public/${slug}`), enabled: !!slug, retry: false });
}

function applyBrand(c?: { primaryColor: string; secondaryColor: string } | null) {
  if (!c) return;
  document.documentElement.style.setProperty('--brand-primary', c.primaryColor);
  document.documentElement.style.setProperty('--brand-secondary', c.secondaryColor);
}

export function PortalLoginPage() {
  const { slug } = useParams();
  const nav = useNavigate();
  const { loginPortal, user } = useAuth();
  const brand = useCompanyBrand(slug);
  useEffect(() => applyBrand(brand.data), [brand.data]);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (user?.role === 'CLIENT' && user.company?.slug === slug) return <Navigate to={`/portal/${slug}`} replace />;
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(''); try { await loginPortal(slug!, identifier, password); nav(`/portal/${slug}`); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  if (brand.isLoading) return <div className="auth-page"><Loading /></div>;
  if (brand.error) return <div className="auth-page"><div className="auth-card"><h1>Portal não encontrado</h1><p className="sub">Verifique o endereço informado pela empresa.</p></div></div>;
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        {brand.data?.logoFileId && <img className="logo" src={`/api/company/public/${slug}/logo`} alt={brand.data.name} />}
        <h1>{brand.data?.name}</h1>
        <p className="sub">Portal do cliente — consulte contratos, parcelas e pagamentos.</p>
        {error && <div className="alert error">{error}</div>}
        <Field label="CPF/CNPJ ou e-mail"><input autoFocus value={identifier} onChange={(e) => setIdentifier(e.target.value)} required /></Field>
        <Field label="Senha"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn primary block" disabled={busy}>{busy ? 'Entrando...' : 'Entrar'}</button>
        <div className="mt small" style={{ textAlign: 'center' }}><Link to={`/portal/${slug}/recuperar-senha`}>Esqueci minha senha</Link></div>
        <p className="small muted mt">Ainda não tem acesso? Solicite à {brand.data?.name} a criação do seu acesso ao portal.</p>
      </form>
    </div>
  );
}

/** Página de destino dos links seguros enviados por e-mail/SMS. */
export function PortalAccessPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { loginWithSession } = useAuth();
  const [error, setError] = useState('');
  useEffect(() => {
    const token = params.get('token');
    if (!token) { setError('Link inválido.'); return; }
    api<{ accessToken: string; user: User; target: string | null; companySlug: string }>('auth/portal/token', { body: { token } })
      .then((r) => { loginWithSession(r.accessToken, r.user); nav(`/portal/${r.companySlug}${r.target ?? ''}`, { replace: true }); })
      .catch((e) => setError(errorMessage(e)));
  }, [params, nav, loginWithSession]);
  return <div className="auth-page"><div className="auth-card">{error ? <><h1>Não foi possível acessar</h1><div className="alert error">{error}</div><Link to={`/portal/${slug}/login`}>Ir para o login</Link></> : <Loading text="Validando seu acesso..." />}</div></div>;
}

export function PortalShell() {
  const { slug } = useParams();
  const { user, loading, logout } = useAuth();
  const me = useQuery({ queryKey: ['portal', 'me'], queryFn: () => api<PortalMe>('portal/me'), enabled: !!user && user.role === 'CLIENT' });
  useEffect(() => applyBrand(me.data?.company), [me.data]);
  if (loading) return <Loading />;
  if (!user || user.role !== 'CLIENT' || user.company?.slug !== slug) return <Navigate to={`/portal/${slug}/login`} replace />;
  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <ErrorState error={me.error} retry={me.refetch} />;
  const base = `/portal/${slug}`;
  return (
    <div className="portal-shell">
      <header className="portal-header">
        <div className="flex">{me.data.company.logoFileId && <img src={`/api/company/public/${slug}/logo`} alt="" style={{ maxHeight: 34, background: '#fff', borderRadius: 4, padding: 2 }} />}<strong>{me.data.company.name}</strong></div>
        <nav>
          <NavLink to={base} end className={({ isActive }) => (isActive ? 'active' : '')}>Início</NavLink>
          <NavLink to={`${base}/parcelas`} className={({ isActive }) => (isActive ? 'active' : '')}>Parcelas</NavLink>
          <NavLink to={`${base}/pagamentos`} className={({ isActive }) => (isActive ? 'active' : '')}>Pagamentos</NavLink>
          <NavLink to={`${base}/atendimento`} className={({ isActive }) => (isActive ? 'active' : '')}>Atendimento</NavLink>
          <NavLink to={`${base}/conta`} className={({ isActive }) => (isActive ? 'active' : '')}>Minha conta{me.data.unreadNotifications ? ` (${me.data.unreadNotifications})` : ''}</NavLink>
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Sair</a>
        </nav>
      </header>
      <main className="portal-content"><Outlet context={me.data} /></main>
    </div>
  );
}

function usePortal() { return useQuery({ queryKey: ['portal', 'me'], queryFn: () => api<PortalMe>('portal/me') }); }

function PortalHome() {
  const { slug } = useParams();
  const { user } = useAuth();
  const q = usePortal();
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <>
      <h1>Olá, {d.client.name.split(' ')[0]}</h1>
      <p className="muted mb">Acompanhe seus contratos e mantenha seus pagamentos em dia.</p>
      {user?.mustChangePassword && <Alert kind="warning">Você está usando uma senha provisória. Altere em “Minha conta”.</Alert>}
      <div className="grid cols-3">
        <Stat label="Saldo devedor" value={brl(d.totals.openBalance)} />
        <Stat label="Em atraso" value={brl(d.totals.overdueBalance)} tone={Number(d.totals.overdueBalance) > 0 ? 'danger' : 'success'} hint={Number(d.totals.overdueBalance) > 0 ? 'Regularize para evitar novos encargos' : 'Nenhuma parcela em atraso'} />
        <Stat label="Contratos" value={d.loans.length} hint={`${d.loans.filter((l) => l.status === 'ACTIVE').length} em andamento`} />
      </div>
      <h2 className="mt mb">Meus contratos</h2>
      {d.loans.length === 0 ? <div className="card"><EmptyState title="Nenhum contrato" /></div> : d.loans.map((l) => (
        <div key={l.id} className="card">
          <div className="card-header"><h3>Contrato nº {l.number}</h3><StatusBadge map={LOAN_STATUS} value={l.status} /></div>
          <div className="grid cols-3">
            <KV items={[['Valor liberado', brl(l.disbursedAmount)], ['Parcelas', `${l.installmentsCount}x ${brl(l.installmentAmount)} (${PERIODICITY[l.periodicity]})`], ['Liberado em', dateBR(l.disbursedAt)]]} />
            <KV items={[['Taxa / CET anual', `${pct(l.monthlyRate)} a.m. / ${pct(l.cetAnnual)}`], ['Método', CALC_METHOD[l.calcMethod]], ['Total do contrato', brl(l.totalAmount)]]} />
            <KV items={[['Saldo devedor', brl(l.summary.openBalance)], ['Parcelas pagas', `${l.summary.paidCount} de ${l.installmentsCount}`], ['Próximo vencimento', l.summary.nextDue ? `${dateBR(l.summary.nextDue.dueDate)} · ${brl(l.summary.nextDue.amount)}` : '—']]} />
          </div>
          <div className="flex mt">
            {l.contracts.filter((c) => c.status === 'SIGNED').map((c) => <button key={c.id} className="btn sm" onClick={() => openFile(`/api/portal/contracts/${c.id}/pdf`)}>Baixar {c.kind === 'ADDENDUM' ? 'aditivo' : 'contrato'} v{c.version}</button>)}
            {l.contracts.some((c) => c.status === 'AWAITING_SIGNATURE') && <Badge tone="warning">Contrato aguardando assinatura</Badge>}
            <Link className="btn sm primary" to={`/portal/${slug}/parcelas`}>Ver parcelas</Link>
          </div>
        </div>
      ))}
    </>
  );
}

function PortalInstallments() {
  const q = usePortal();
  const qc = useQueryClient();
  const toast = useToast();
  const [pay, setPay] = useState<{ loan: PortalLoan; inst: PortalLoan['installments'][number] } | null>(null);
  const [proof, setProof] = useState<{ inst: Installment } | null>(null);
  const [proofForm, setProofForm] = useState({ amount: '', paidAt: todayISO(), notes: '', file: null as File | null });
  const charge = useMutation({ mutationFn: (v: { installmentId: string; type: 'PIX' | 'BOLETO' }) => api('portal/charges', { body: v }), onSuccess: () => { toast('Cobrança gerada', 'success'); qc.invalidateQueries({ queryKey: ['portal'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const sendProof = useMutation({ mutationFn: async () => { const fd = new FormData(); fd.append('installmentId', proof!.inst.id); fd.append('amount', proofForm.amount); fd.append('paidAt', proofForm.paidAt); fd.append('notes', proofForm.notes); if (proofForm.file) fd.append('file', proofForm.file); return api('portal/proofs', { formData: fd }); }, onSuccess: () => { toast('Comprovante enviado. Aguarde a conferência.', 'success'); setProof(null); qc.invalidateQueries({ queryKey: ['portal'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  if (!q.data) return <Loading />;
  const d = q.data;
  const rows = d.loans.filter((l) => l.status === 'ACTIVE').flatMap((l) => l.installments.map((i) => ({ ...i, loan: l })));
  return (
    <>
      <h1>Parcelas</h1>
      <p className="muted mb">Valores atualizados em {dateBR(d.today)}. Parcelas em atraso incluem multa e juros de mora conforme o contrato.</p>
      <div className="card">
        <DataTable rows={rows} emptyTitle="Nenhuma parcela em contratos ativos" cardTitle={(i) => `Contrato ${i.loan.number} · parcela ${i.number}`} initialSort={{ key: 'dueDate', dir: 'asc' }} pageSize={50} columns={[
          { key: 'loan', label: 'Contrato', render: (i) => i.loan.number },
          { key: 'number', label: 'Parcela', render: (i) => `${i.number}/${i.loan.installmentsCount}` },
          { key: 'dueDate', label: 'Vencimento', render: (i) => dateBR(i.dueDate), sortValue: (i) => i.dueDate },
          { key: 'original', label: 'Valor', num: true, render: (i) => brl(i.originalAmount) },
          { key: 'paid', label: 'Pago', num: true, render: (i) => brl(Number(i.paidPrincipal) + Number(i.paidInterest) + Number(i.paidCharges)) },
          { key: 'due', label: 'Saldo', num: true, render: (i) => <strong>{brl(i.balance.totalDue)}</strong> },
          { key: 'status', label: 'Situação', render: (i) => <StatusBadge map={INSTALLMENT_STATUS} value={i.balance.displayStatus} /> },
          { key: 'act', label: '', render: (i) => ['PENDING', 'PARTIAL'].includes(i.status) && <span className="flex"><button className="btn sm primary" onClick={() => setPay({ loan: i.loan, inst: i })}>Pagar</button><button className="btn sm" onClick={() => { setProof({ inst: i }); setProofForm({ amount: i.balance.totalDue, paidAt: todayISO(), notes: '', file: null }); }}>Enviar comprovante</button></span> },
        ]} />
      </div>
      {pay && (
        <Modal title={`Pagar parcela ${pay.inst.number} — contrato ${pay.loan.number}`} onClose={() => setPay(null)}>
          <KV items={[['Vencimento', dateBR(pay.inst.dueDate)], ['Valor atualizado', <strong>{brl(pay.inst.balance.totalDue)}</strong>], ...(pay.inst.balance.daysLate ? [['Encargos de atraso', `${brl(pay.inst.balance.chargesDue)} (${pay.inst.balance.daysLate} dias)`] as [string, string]] : [])]} />
          <h3 className="mt">Meios de pagamento</h3>
          {d.company.settings.pixKey && <p><strong>Chave Pix da empresa:</strong> <span className="mono">{d.company.settings.pixKey}</span></p>}
          {d.company.settings.paymentInstructions && <p className="small muted">{d.company.settings.paymentInstructions}</p>}
          {pay.inst.charges.length > 0 ? pay.inst.charges.map((c) => <div key={c.id} className="alert info"><strong>{c.type === 'PIX' ? 'Pix' : 'Boleto'} — {brl(c.amount)}</strong>{c.payload && Object.entries(c.payload).map(([k, v]) => <div key={k} className="small"><strong>{k}:</strong> <span className="mono" style={{ wordBreak: 'break-all' }}>{v}</span></div>)}{c.expiresAt && <div className="small muted">Válido até {dateTimeBR(c.expiresAt)}</div>}</div>) : (
            <div className="flex"><button className="btn primary" disabled={charge.isPending} onClick={() => charge.mutate({ installmentId: pay.inst.id, type: 'PIX' })}>Gerar Pix</button><button className="btn" disabled={charge.isPending} onClick={() => charge.mutate({ installmentId: pay.inst.id, type: 'BOLETO' })}>Gerar boleto</button></div>
          )}
          {d.paymentsProvider === 'mock' && <p className="small muted mt">Ambiente de demonstração: as cobranças Pix/boleto são simuladas.</p>}
          <p className="small muted mt">Pagou por outro meio? Use “Enviar comprovante” para a empresa conferir.</p>
        </Modal>
      )}
      {proof && (
        <Modal title="Enviar comprovante de pagamento" onClose={() => setProof(null)}>
          <Alert kind="info">O comprovante ficará pendente até a conferência pela empresa. Após a validação, o recibo ficará disponível em “Pagamentos”.</Alert>
          <div className="form-row"><Field label="Valor pago (R$)"><input type="number" step="0.01" value={proofForm.amount} onChange={(e) => setProofForm({ ...proofForm, amount: e.target.value })} /></Field><Field label="Data do pagamento"><input type="date" value={proofForm.paidAt} onChange={(e) => setProofForm({ ...proofForm, paidAt: e.target.value })} /></Field></div>
          <Field label="Arquivo do comprovante (imagem ou PDF)"><input type="file" accept="image/*,application/pdf" onChange={(e) => setProofForm({ ...proofForm, file: e.target.files?.[0] ?? null })} /></Field>
          <Field label="Observações"><textarea value={proofForm.notes} onChange={(e) => setProofForm({ ...proofForm, notes: e.target.value })} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setProof(null)}>Cancelar</button><button className="btn primary" disabled={sendProof.isPending || !proofForm.file} onClick={() => sendProof.mutate()}>Enviar</button></div>
        </Modal>
      )}
    </>
  );
}

function PortalPayments() {
  const q = useQuery({ queryKey: ['portal', 'payments'], queryFn: () => api<Array<{ id: string; paidAt: string; amount: string; method: string; status: string; receiptNumber: number | null; notes: string | null; loan: { number: number }; installment: { number: number } }>>('portal/payments') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <>
      <h1>Pagamentos</h1>
      <p className="muted mb">Histórico de pagamentos confirmados e comprovantes em conferência.</p>
      <div className="card">
        <DataTable rows={q.data!} emptyTitle="Nenhum pagamento registrado" cardTitle={(p) => `${brl(p.amount)} · ${dateBR(p.paidAt)}`} columns={[
          { key: 'paidAt', label: 'Data', render: (p) => dateBR(p.paidAt), sortValue: (p) => p.paidAt }, { key: 'loan', label: 'Contrato / parcela', render: (p) => `${p.loan.number} / ${p.installment.number}` }, { key: 'amount', label: 'Valor', num: true, render: (p) => brl(p.amount) }, { key: 'method', label: 'Forma', render: (p) => PAYMENT_METHOD[p.method] },
          { key: 'status', label: 'Situação', render: (p) => <><StatusBadge map={PAYMENT_STATUS} value={p.status} />{p.status === 'REJECTED' && p.notes && <div className="small muted">{p.notes}</div>}</> },
          { key: 'receipt', label: 'Recibo', render: (p) => (p.status === 'CONFIRMED' && p.receiptNumber ? <button className="btn sm" onClick={() => openFile(`/api/portal/payments/${p.id}/receipt`)}>Recibo nº {p.receiptNumber}</button> : '—') },
        ]} />
      </div>
    </>
  );
}

function PortalSupport() {
  const me = usePortal();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['portal', 'requests'], queryFn: () => api<Array<{ id: string; type: string; message: string; status: string; response: string | null; createdAt: string; loan: { number: number } | null }>>('portal/requests') });
  const [form, setForm] = useState({ type: 'SUPPORT', loanId: '', message: '' });
  const send = useMutation({ mutationFn: () => api('portal/requests', { body: { type: form.type, loanId: form.loanId || null, message: form.message } }), onSuccess: () => { toast('Solicitação enviada', 'success'); setForm({ ...form, message: '' }); qc.invalidateQueries({ queryKey: ['portal'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const TYPE: Record<string, string> = { SUPPORT: 'Atendimento', RENEGOTIATION: 'Pedido de renegociação', DISPUTE: 'Contestação' };
  const ST: Record<string, { label: string; tone: string }> = { OPEN: { label: 'Recebida', tone: 'info' }, IN_PROGRESS: { label: 'Em análise', tone: 'warning' }, CLOSED: { label: 'Concluída', tone: 'success' } };
  return (
    <>
      <h1>Atendimento</h1>
      <div className="grid cols-2 mt">
        <div className="card">
          <h3>Nova solicitação</h3>
          <Field label="Assunto"><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Contrato (opcional)"><select value={form.loanId} onChange={(e) => setForm({ ...form, loanId: e.target.value })}><option value="">—</option>{me.data?.loans.map((l) => <option key={l.id} value={l.id}>Contrato nº {l.number}</option>)}</select></Field>
          <Field label="Mensagem"><textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
          {form.type === 'DISPUTE' && <Alert kind="info">Ao registrar uma contestação vinculada a um contrato, os lembretes de cobrança daquele contrato são pausados até a análise.</Alert>}
          <button className="btn primary" disabled={send.isPending || form.message.length < 5} onClick={() => send.mutate()}>Enviar</button>
          {me.data?.company.phone || me.data?.company.email ? <p className="small muted mt">Outros canais: {me.data.company.phone && maskPhone(me.data.company.phone)} {me.data.company.email}</p> : null}
        </div>
        <div className="card">
          <h3>Minhas solicitações</h3>
          {q.isLoading ? <Loading /> : q.data!.length === 0 ? <EmptyState title="Nenhuma solicitação" /> : q.data!.map((s) => <div key={s.id} className="tcard mb"><div className="flex between"><strong>{TYPE[s.type]}{s.loan && ` · contrato ${s.loan.number}`}</strong><StatusBadge map={ST} value={s.status} /></div><div className="small muted">{dateTimeBR(s.createdAt)}</div><p style={{ whiteSpace: 'pre-wrap' }}>{s.message}</p>{s.response && <div className="alert success">Resposta: {s.response}</div>}</div>)}
        </div>
      </div>
    </>
  );
}

function PortalAccount() {
  const me = usePortal();
  const qc = useQueryClient();
  const toast = useToast();
  const { refreshUser } = useAuth();
  const notif = useQuery({ queryKey: ['portal', 'notifications'], queryFn: () => api<Array<{ id: string; title: string; body: string; createdAt: string; readAt: string | null }>>('portal/notifications') });
  const [prefs, setPrefs] = useState({ email: '', phone: '', pEmail: true, pSms: true, pPortal: true });
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  useEffect(() => { if (me.data) setPrefs({ email: me.data.client.email ?? '', phone: maskPhone(me.data.client.phone), pEmail: me.data.client.contactPreferences?.email !== false, pSms: me.data.client.contactPreferences?.sms !== false, pPortal: me.data.client.contactPreferences?.portal !== false }); }, [me.data]);
  useEffect(() => { if (notif.data?.some((n) => !n.readAt)) api('portal/notifications/read', { method: 'POST', body: {} }).then(() => qc.invalidateQueries({ queryKey: ['portal', 'me'] })); }, [notif.data, qc]);
  const save = useMutation({ mutationFn: () => api('portal/preferences', { method: 'PUT', body: { email: prefs.email || null, phone: prefs.phone || null, contactPreferences: { email: prefs.pEmail, sms: prefs.pSms, portal: prefs.pPortal } } }), onSuccess: () => { toast('Preferências salvas', 'success'); qc.invalidateQueries({ queryKey: ['portal'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const changePw = async () => { if (pw.next !== pw.confirm) return toast('As senhas não conferem', 'error'); try { await api('auth/change-password', { body: { currentPassword: pw.current, newPassword: pw.next } }); toast('Senha alterada', 'success'); setPw({ current: '', next: '', confirm: '' }); await refreshUser(); } catch (e) { toast(errorMessage(e), 'error'); } };
  if (!me.data) return <Loading />;
  return (
    <>
      <h1>Minha conta</h1>
      <div className="grid cols-2 mt">
        <div>
          <div className="card">
            <h3>Dados e preferências de contato</h3>
            <KV items={[['Nome', me.data.client.name], ['Documento', maskDocument(me.data.client.document)]]} />
            <div className="form-row mt"><Field label="E-mail"><input value={prefs.email} onChange={(e) => setPrefs({ ...prefs, email: e.target.value })} /></Field><Field label="Celular"><input value={prefs.phone} onChange={(e) => setPrefs({ ...prefs, phone: e.target.value })} /></Field></div>
            <label className="check"><input type="checkbox" checked={prefs.pEmail} onChange={(e) => setPrefs({ ...prefs, pEmail: e.target.checked })} /> Receber lembretes por e-mail</label>
            <label className="check"><input type="checkbox" checked={prefs.pSms} onChange={(e) => setPrefs({ ...prefs, pSms: e.target.checked })} /> Receber lembretes por SMS</label>
            <label className="check"><input type="checkbox" checked={prefs.pPortal} onChange={(e) => setPrefs({ ...prefs, pPortal: e.target.checked })} /> Receber avisos no portal</label>
            <button className="btn primary mt" onClick={() => save.mutate()} disabled={save.isPending}>Salvar</button>
          </div>
          <div className="card">
            <h3>Alterar senha</h3>
            <Field label="Senha atual"><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
            <Field label="Nova senha" help="Mínimo 8 caracteres, letras e números"><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
            <Field label="Confirmar nova senha"><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
            <button className="btn primary" onClick={changePw}>Alterar senha</button>
          </div>
        </div>
        <div className="card">
          <h3>Avisos</h3>
          {notif.isLoading ? <Loading /> : notif.data!.length === 0 ? <EmptyState title="Nenhum aviso" /> : notif.data!.map((n) => <div key={n.id} className="tcard mb" style={{ background: n.readAt ? undefined : 'var(--blue-100)' }}><strong>{n.title}</strong><div className="small muted">{dateTimeBR(n.createdAt)}</div><p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p></div>)}
        </div>
      </div>
    </>
  );
}

export const portalRoutes = (
  <>
    <Route index element={<PortalHome />} />
    <Route path="parcelas" element={<PortalInstallments />} />
    <Route path="pagamentos" element={<PortalPayments />} />
    <Route path="atendimento" element={<PortalSupport />} />
    <Route path="conta" element={<PortalAccount />} />
  </>
);
