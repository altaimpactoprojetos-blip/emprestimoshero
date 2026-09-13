import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { ROLE } from '../../lib/labels';
import { dateTimeBR } from '../../lib/format';
import { PageHeader, Loading, ErrorState, Field, useForm, useToast, errorMessage, Tabs, DataTable, Modal, Alert, Badge } from '../../components/ui';
import { ProductsSettings } from './LoansPages';

export function SettingsPage() {
  const [tab, setTab] = useState('empresa');
  const { can, user } = useAuth();
  const tabs = [
    { key: 'empresa', label: 'Empresa e marca' },
    ...(can('settings.manage') ? [{ key: 'produtos', label: 'Produtos de crédito' }] : []),
    ...(can('users.manage') ? [{ key: 'usuarios', label: 'Usuários' }, { key: 'permissoes', label: 'Permissões' }] : []),
    { key: 'seguranca', label: 'Minha conta e 2FA' },
    { key: 'integracoes', label: 'Integrações' },
  ];
  return (
    <>
      <PageHeader title="Configurações" subtitle={user?.company?.name} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'empresa' && <CompanySettings />}
      {tab === 'produtos' && <ProductsSettings />}
      {tab === 'usuarios' && <UsersSettings />}
      {tab === 'permissoes' && <PermissionsSettings />}
      {tab === 'seguranca' && <SecuritySettings />}
      {tab === 'integracoes' && <IntegrationsSettings />}
    </>
  );
}

interface CompanyMe { id: string; name: string; legalName: string | null; cnpj: string | null; email: string | null; phone: string | null; address: string | null; primaryColor: string; secondaryColor: string; timezone: string; logoFileId: string | null; slug: string; settings: Record<string, unknown>; integrations: Record<string, string>; plan: { name: string; maxUsers: number } | null }

function CompanySettings() {
  const toast = useToast();
  const { refreshUser, can } = useAuth();
  const q = useQuery({ queryKey: ['company', 'me'], queryFn: () => api<CompanyMe>('company/me') });
  const f = useForm({ name: '', legalName: '', cnpj: '', email: '', phone: '', address: '', primaryColor: '#0B2A4A', secondaryColor: '#1F6FB2', timezone: 'America/Sao_Paulo', require2faForAdmins: false, pixKey: '', paymentInstructions: '', receiptFooter: '' });
  useEffect(() => {
    if (q.data) {
      const s = q.data.settings as Record<string, string | boolean>;
      f.setValues({ name: q.data.name, legalName: q.data.legalName ?? '', cnpj: q.data.cnpj ?? '', email: q.data.email ?? '', phone: q.data.phone ?? '', address: q.data.address ?? '', primaryColor: q.data.primaryColor, secondaryColor: q.data.secondaryColor, timezone: q.data.timezone, require2faForAdmins: !!s.require2faForAdmins, pixKey: String(s.pixKey ?? ''), paymentInstructions: String(s.paymentInstructions ?? ''), receiptFooter: String(s.receiptFooter ?? '') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('company/me', { method: 'PUT', body: { name: f.values.name, legalName: f.values.legalName || null, cnpj: f.values.cnpj || null, email: f.values.email || null, phone: f.values.phone || null, address: f.values.address || null, primaryColor: f.values.primaryColor, secondaryColor: f.values.secondaryColor, timezone: f.values.timezone, settings: { require2faForAdmins: f.values.require2faForAdmins, pixKey: f.values.pixKey, paymentInstructions: f.values.paymentInstructions, receiptFooter: f.values.receiptFooter } } }),
    onSuccess: async () => { toast('Configurações salvas', 'success'); await refreshUser(); q.refetch(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const uploadLogo = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try { await api('company/me/logo', { formData: fd }); toast('Logo atualizado', 'success'); await refreshUser(); q.refetch(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const ro = !can('settings.manage');
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Dados da empresa</h3>
        {ro && <Alert kind="info">Somente administradores podem alterar estas configurações.</Alert>}
        <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }}>
          <Field label="Nome fantasia"><input {...f.bind('name')} /></Field>
          <Field label="Razão social"><input {...f.bind('legalName')} /></Field>
          <div className="form-row"><Field label="CNPJ"><input {...f.bind('cnpj')} /></Field><Field label="Telefone"><input {...f.bind('phone')} /></Field></div>
          <Field label="E-mail"><input {...f.bind('email')} /></Field>
          <Field label="Endereço"><input {...f.bind('address')} /></Field>
          <Field label="Fuso horário"><select {...f.bind('timezone')}>{['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Noronha'].map((t) => <option key={t}>{t}</option>)}</select></Field>
          <h3>Pagamentos e recibos</h3>
          <Field label="Chave Pix da empresa" help="Exibida ao cliente como meio de pagamento"><input {...f.bind('pixKey')} /></Field>
          <Field label="Instruções de pagamento"><textarea {...f.bind('paymentInstructions')} /></Field>
          <Field label="Rodapé dos recibos"><input {...f.bind('receiptFooter')} /></Field>
          <h3>Segurança</h3>
          <label className="check"><input type="checkbox" {...f.bindCheck('require2faForAdmins')} /> Exigir autenticação em duas etapas para administradores</label>
          <div className="form-actions"><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
        </fieldset>
      </div>
      <div>
        <div className="card">
          <h3>Identidade visual</h3>
          <div className="flex mb">{q.data!.logoFileId && <img src={`/api/company/public/${q.data!.slug}/logo`} alt="Logo" style={{ maxHeight: 60, maxWidth: 200, border: '1px solid var(--border)', padding: 4, borderRadius: 4 }} />}</div>
          <Field label="Logo (PNG, JPG, SVG ou WEBP)"><input type="file" accept="image/*" disabled={ro} onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} /></Field>
          <div className="form-row">
            <Field label="Cor principal (menu)"><input type="color" disabled={ro} {...f.bind('primaryColor')} /></Field>
            <Field label="Cor de destaque (botões)"><input type="color" disabled={ro} {...f.bind('secondaryColor')} /></Field>
          </div>
          <p className="small muted">As cores são aplicadas ao painel da equipe e ao portal do cliente após salvar.</p>
        </div>
        <div className="card">
          <h3>Plano contratado</h3>
          <p>{q.data!.plan ? `${q.data!.plan.name} — até ${q.data!.plan.maxUsers} usuários` : 'Sem plano vinculado'}</p>
          <p className="small muted">Endereço do portal do cliente: <span className="mono">{window.location.origin}/portal/{q.data!.slug}</span></p>
        </div>
      </div>
    </div>
  );
}

interface StaffUser { id: string; name: string; email: string; role: string; active: boolean; twoFactorEnabled: boolean; lastLoginAt: string | null; permissionGrants: string[]; permissionDenies: string[] }

function UsersSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<StaffUser[]>('users') });
  const matrix = useQuery({ queryKey: ['users', 'matrix'], queryFn: () => api<{ permissions: Array<{ key: string; label: string }>; roles: Array<{ role: string; permissions: string[] }> }>('users/permissions/matrix') });
  const [editing, setEditing] = useState<StaffUser | 'new' | null>(null);
  const f = useForm({ name: '', email: '', role: 'FINANCE', password: '', active: true, grants: [] as string[], denies: [] as string[] });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.values.name, email: f.values.email, role: f.values.role, active: f.values.active, permissionGrants: f.values.grants, permissionDenies: f.values.denies, ...(f.values.password ? { password: f.values.password } : {}) };
      return editing === 'new' ? api('users', { body }) : api(`users/${(editing as StaffUser).id}`, { method: 'PUT', body });
    },
    onSuccess: () => { toast('Usuário salvo', 'success'); setEditing(null); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const open = (u: StaffUser | 'new') => {
    if (u === 'new') f.reset(); else f.setValues({ name: u.name, email: u.email, role: u.role, password: '', active: u.active, grants: u.permissionGrants, denies: u.permissionDenies });
    setEditing(u);
  };
  const toggle = (list: 'grants' | 'denies', key: string) => {
    const cur = f.values[list];
    f.set(list, cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
  };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const rolePerms = matrix.data?.roles.find((r) => r.role === f.values.role)?.permissions ?? [];
  return (
    <div className="card">
      <div className="card-header"><h3>Equipe</h3><button className="btn primary" onClick={() => open('new')}>Novo usuário</button></div>
      <DataTable rows={q.data!} searchKeys={(u) => `${u.name} ${u.email}`} onRowClick={open} cardTitle={(u) => u.name} columns={[
        { key: 'name', label: 'Nome', sortValue: (u) => u.name },
        { key: 'email', label: 'E-mail' },
        { key: 'role', label: 'Perfil', render: (u) => ROLE[u.role] },
        { key: 'active', label: 'Situação', render: (u) => <Badge tone={u.active ? 'success' : 'neutral'}>{u.active ? 'Ativo' : 'Inativo'}</Badge> },
        { key: 'twoFactorEnabled', label: '2FA', render: (u) => (u.twoFactorEnabled ? <Badge tone="success">Ativo</Badge> : <Badge>Não</Badge>) },
        { key: 'lastLoginAt', label: 'Último acesso', render: (u) => dateTimeBR(u.lastLoginAt) },
      ]} />
      {editing && (
        <Modal title={editing === 'new' ? 'Novo usuário' : 'Editar usuário'} onClose={() => setEditing(null)} wide>
          <div className="form-row">
            <Field label="Nome"><input {...f.bind('name')} /></Field>
            <Field label="E-mail"><input type="email" {...f.bind('email')} /></Field>
            <Field label="Perfil"><select {...f.bind('role')}><option value="COMPANY_ADMIN">Administrador</option><option value="FINANCE">Financeiro</option><option value="COLLECTION">Atendimento/Cobrança</option></select></Field>
            <Field label={editing === 'new' ? 'Senha provisória' : 'Nova senha (opcional)'} help="O usuário deverá alterá-la no primeiro acesso"><input type="password" {...f.bind('password')} /></Field>
          </div>
          <label className="check"><input type="checkbox" {...f.bindCheck('active')} /> Usuário ativo</label>
          {f.values.role !== 'COMPANY_ADMIN' && matrix.data && (
            <>
              <h3 className="mt">Ajustes individuais de permissão</h3>
              <p className="small muted">O perfil define as permissões padrão. Marque para conceder além do perfil ou negar apesar do perfil.</p>
              <div className="table-wrap"><table className="table"><thead><tr><th>Permissão</th><th>Pelo perfil</th><th>Conceder</th><th>Negar</th></tr></thead><tbody>
                {matrix.data.permissions.map((p) => (
                  <tr key={p.key}><td>{p.label}</td><td>{rolePerms.includes(p.key) ? 'Sim' : '—'}</td>
                    <td><input type="checkbox" checked={f.values.grants.includes(p.key)} onChange={() => toggle('grants', p.key)} /></td>
                    <td><input type="checkbox" checked={f.values.denies.includes(p.key)} onChange={() => toggle('denies', p.key)} /></td></tr>
                ))}
              </tbody></table></div>
            </>
          )}
          <div className="form-actions"><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
        </Modal>
      )}
    </div>
  );
}

function PermissionsSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['users', 'matrix'], queryFn: () => api<{ permissions: Array<{ key: string; label: string }>; roles: Array<{ role: string; label: string; permissions: string[]; isDefault: boolean }> }>('users/permissions/matrix') });
  const [local, setLocal] = useState<Record<string, string[]>>({});
  useEffect(() => { if (q.data) setLocal(Object.fromEntries(q.data.roles.map((r) => [r.role, r.permissions]))); }, [q.data]);
  const save = useMutation({
    mutationFn: (role: string) => api(`users/permissions/matrix/${role}`, { method: 'PUT', body: { permissions: local[role] } }),
    onSuccess: () => { toast('Permissões do perfil salvas', 'success'); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const editable = ['FINANCE', 'COLLECTION'];
  return (
    <div className="card">
      <h3>Permissões por perfil</h3>
      <p className="muted">Defina o que cada perfil pode visualizar, cadastrar, aprovar, registrar, conceder, renegociar e exportar. O administrador sempre tem acesso completo.</p>
      <div className="table-wrap"><table className="table"><thead><tr><th>Permissão</th>{q.data!.roles.map((r) => <th key={r.role}>{r.label}</th>)}</tr></thead><tbody>
        {q.data!.permissions.map((p) => (
          <tr key={p.key}><td>{p.label}</td>{q.data!.roles.map((r) => (
            <td key={r.role}><input type="checkbox" disabled={!editable.includes(r.role)} checked={(local[r.role] ?? []).includes(p.key)} onChange={(e) => setLocal((s) => ({ ...s, [r.role]: e.target.checked ? [...(s[r.role] ?? []), p.key] : (s[r.role] ?? []).filter((k) => k !== p.key) }))} /></td>
          ))}</tr>
        ))}
      </tbody></table></div>
      <div className="form-actions">{editable.map((r) => <button key={r} className="btn primary" onClick={() => save.mutate(r)} disabled={save.isPending}>Salvar {ROLE[r]}</button>)}</div>
    </div>
  );
}

function SecuritySettings() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [disablePw, setDisablePw] = useState('');
  const start = async () => { try { setSetup(await api('auth/2fa/setup', { method: 'POST', body: {} })); } catch (e) { toast(errorMessage(e), 'error'); } };
  const enable = async () => { try { await api('auth/2fa/enable', { body: { code } }); toast('Autenticação em duas etapas ativada', 'success'); setSetup(null); await refreshUser(); } catch (e) { toast(errorMessage(e), 'error'); } };
  const disable = async () => { try { await api('auth/2fa/disable', { body: { password: disablePw } }); toast('2FA desativada', 'success'); setDisablePw(''); await refreshUser(); } catch (e) { toast(errorMessage(e), 'error'); } };
  const changePw = async () => {
    if (pw.next !== pw.confirm) return toast('As senhas não conferem', 'error');
    try { await api('auth/change-password', { body: { currentPassword: pw.current, newPassword: pw.next } }); toast('Senha alterada', 'success'); setPw({ current: '', next: '', confirm: '' }); await refreshUser(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Autenticação em duas etapas (2FA)</h3>
        {user?.twoFactorEnabled ? (
          <>
            <Alert kind="success">Ativa. Um código do aplicativo autenticador será exigido em cada login.</Alert>
            <Field label="Confirme sua senha para desativar"><input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} /></Field>
            <button className="btn danger" onClick={disable} disabled={!disablePw}>Desativar 2FA</button>
          </>
        ) : setup ? (
          <>
            <p>1. Adicione a chave abaixo no seu aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy):</p>
            <pre className="code">{setup.secret}</pre>
            <p className="small muted">Ou use o endereço: <span className="mono" style={{ wordBreak: 'break-all' }}>{setup.otpauthUrl}</span></p>
            <p>2. Informe o código gerado para confirmar:</p>
            <Field label="Código"><input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <div className="flex"><button className="btn primary" onClick={enable}>Ativar</button><button className="btn" onClick={() => setSetup(null)}>Cancelar</button></div>
          </>
        ) : (
          <>
            <p className="muted">Recomendada para administradores. Protege a conta mesmo que a senha seja descoberta.</p>
            <button className="btn primary" onClick={start}>Configurar 2FA</button>
          </>
        )}
      </div>
      <div className="card">
        <h3>Alterar senha</h3>
        {user?.mustChangePassword && <Alert kind="warning">Você está usando uma senha provisória. Defina uma nova senha.</Alert>}
        <Field label="Senha atual"><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
        <Field label="Nova senha"><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        <Field label="Confirmar nova senha"><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
        <button className="btn primary" onClick={changePw}>Alterar senha</button>
      </div>
    </div>
  );
}

function IntegrationsSettings() {
  const q = useQuery({ queryKey: ['company', 'me'], queryFn: () => api<CompanyMe>('company/me') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const i = q.data!.integrations;
  const row = (label: string, value: string, ok: boolean, desc: string) => (
    <tr><td><strong>{label}</strong><div className="small muted">{desc}</div></td><td><Badge tone={ok ? 'success' : 'warning'}>{ok ? `Conectado (${value})` : `Não conectado — modo ${value}`}</Badge></td></tr>
  );
  return (
    <div className="card">
      <h3>Integrações externas</h3>
      <p className="muted">As integrações são configuradas no servidor pelo administrador da plataforma (variáveis de ambiente). Enquanto não conectadas, o sistema opera em modo de demonstração: mensagens são registradas no histórico sem envio real e cobranças Pix/boleto são simuladas.</p>
      <div className="table-wrap"><table className="table"><tbody>
        {row('E-mail (SMTP)', i.email, i.email === 'smtp', 'Envio de lembretes de cobrança, recibos e recuperação de senha')}
        {row('SMS', i.sms, i.sms !== 'console', 'Envio de lembretes por SMS (provedor com política que permite cobrança)')}
        {row('Pagamentos (Pix e boleto)', i.payments, i.payments !== 'mock', 'Geração de cobranças identificadas por parcela e confirmação automática por webhook')}
        {row('Assinatura eletrônica', i.signature, i.signature !== 'mock', 'Coleta de assinaturas dos contratos com evidências do provedor')}
      </tbody></table></div>
      <Alert kind="info">WhatsApp não é utilizado na automação de cobrança de dívidas, em respeito às políticas de uso do canal.</Alert>
    </div>
  );
}
