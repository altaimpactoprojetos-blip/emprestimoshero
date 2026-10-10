import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, downloadFile } from '../../../lib/api';
import type { CreditorSettings, LendingSettings } from '../../../lib/types';
import { useAuth } from '../../../auth/AuthContext';
import { Loading, ErrorState, Field, Alert, useToast, errorMessage } from '../../../components/ui';
import { getTheme, setTheme, type Theme } from '../../../lib/theme';
import { maskDocument, todayISO } from '../../../lib/format';

interface SettingsData { creditor: CreditorSettings; lending: LendingSettings }

function useLendingSettings() {
  return useQuery({ queryKey: ['lending-settings'], queryFn: () => api<SettingsData>('lending/settings') });
}

function useSaveSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: Partial<SettingsData>) => api<SettingsData>('lending/settings', { method: 'PUT', body }),
    onSuccess: (d) => { qc.setQueryData(['lending-settings'], d); toast('Configurações salvas', 'success'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
}

/** Dados do credor, cadastrados uma única vez e usados em contratos e recibos. */
export function CreditorTab() {
  const q = useLendingSettings();
  const save = useSaveSettings();
  const { can } = useAuth();
  const [v, setV] = useState<CreditorSettings>({});
  useEffect(() => { if (q.data) setV({ ...q.data.creditor, cpf: maskDocument(q.data.creditor.cpf) }); }, [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const bind = (k: keyof CreditorSettings) => ({ value: v[k] ?? '', onChange: (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value })), disabled: !can('settings.manage') });
  return (
    <div className="card">
      <h3>Meus dados de credor</h3>
      <p className="small muted">Usados automaticamente nos contratos e recibos. Cadastre uma única vez.</p>
      <Field label="Nome completo"><input {...bind('name')} /></Field>
      <div className="form-row">
        <Field label="CPF"><input inputMode="numeric" {...bind('cpf')} /></Field>
        <Field label="RG"><input {...bind('rg')} /></Field>
        <Field label="Nacionalidade"><input {...bind('nationality')} placeholder="brasileiro(a)" /></Field>
        <Field label="Estado civil"><input {...bind('maritalStatus')} placeholder="casado(a), solteiro(a)..." /></Field>
        <Field label="Profissão"><input {...bind('profession')} /></Field>
        <Field label="Telefone"><input type="tel" {...bind('phone')} /></Field>
      </div>
      <Field label="Endereço (rua, número, bairro)"><input {...bind('address')} /></Field>
      <div className="form-row">
        <Field label="Cidade"><input {...bind('city')} /></Field>
        <Field label="UF"><input maxLength={2} {...bind('state')} /></Field>
      </div>
      <Field label="Chave PIX para receber" help="Aparece no contrato como forma de pagamento"><input {...bind('pixKey')} /></Field>
      {can('settings.manage') && <div className="form-actions"><button className="btn primary lg" disabled={save.isPending} onClick={() => save.mutate({ creditor: { ...v, cpf: (v.cpf ?? '').replace(/\D/g, ''), state: (v.state ?? '').toUpperCase() } })}>Salvar meus dados</button></div>}
    </div>
  );
}

/** Padrões de cálculo: juros não pagos, multa, mora e cláusulas do contrato. */
export function CalcTab() {
  const q = useLendingSettings();
  const save = useSaveSettings();
  const { can } = useAuth();
  const [v, setV] = useState<LendingSettings | null>(null);
  useEffect(() => { if (q.data) setV(q.data.lending); }, [q.data]);
  if (q.isLoading || !v) return <Loading />;
  const set = <K extends keyof LendingSettings>(k: K, val: LendingSettings[K]) => setV((s) => ({ ...s!, [k]: val }));
  const ro = !can('settings.manage');
  return (
    <div className="card">
      <h3>Cálculo de juros e atraso</h3>
      <Field label="Quando o cliente paga menos que os juros do período, a diferença..." help="Vale para os novos empréstimos; cada empréstimo pode ter sua própria escolha.">
        <select disabled={ro} value={v.pendingInterestMode} onChange={(e) => set('pendingInterestMode', e.target.value as LendingSettings['pendingInterestMode'])}>
          <option value="SEPARATE">Fica como juros pendentes, separada do principal</option>
          <option value="CAPITALIZE">É somada ao principal no período seguinte</option>
        </select>
      </Field>
      <Alert kind="info">Exemplo: R$ 1.000 a 10% ao mês, cliente paga R$ 60. Separados: no mês seguinte deve R$ 40 + R$ 100 de juros (total R$ 1.140). Somados: o principal vira R$ 1.040 e os juros do mês seguinte são R$ 104.</Alert>
      <div className="form-row">
        <Field label="Multa por atraso (%)" help="Opcional. Cobrada uma vez sobre o valor vencido"><input disabled={ro} type="number" step="0.01" min="0" value={v.lateFineRate} onChange={(e) => set('lateFineRate', e.target.value)} /></Field>
        <Field label="Juros de mora (% ao mês)" help="Opcional. Proporcional aos dias de atraso"><input disabled={ro} type="number" step="0.01" min="0" value={v.lateInterestMonthly} onChange={(e) => set('lateInterestMonthly', e.target.value)} /></Field>
      </div>
      <h3 className="mt">Contrato</h3>
      <div className="form-row">
        <Field label="Vencimento antecipado após (dias de atraso)"><input disabled={ro} type="number" min="0" value={v.accelerationDays} onChange={(e) => set('accelerationDays', Number(e.target.value))} /></Field>
        <Field label="Termo de quitação em até (dias)"><input disabled={ro} type="number" min="0" value={v.quitationDays} onChange={(e) => set('quitationDays', Number(e.target.value))} /></Field>
      </div>
      <Field label="Foro (cidade/UF)" help="Ex.: Campinas/SP"><input disabled={ro} value={v.forumCity} onChange={(e) => set('forumCity', e.target.value)} /></Field>
      {!ro && <div className="form-actions"><button className="btn primary lg" disabled={save.isPending} onClick={() => save.mutate({ lending: { ...v, lateFineRate: v.lateFineRate || '0', lateInterestMonthly: v.lateInterestMonthly || '0' } })}>Salvar</button></div>}
    </div>
  );
}

export function BackupTab() {
  const toast = useToast();
  const { can } = useAuth();
  const dl = async (path: string, name: string) => { try { await downloadFile(path, name); toast('Arquivo baixado', 'success'); } catch (e) { toast(errorMessage(e), 'error'); } };
  const d = todayISO();
  return (
    <div className="card">
      <h3>Exportar dados</h3>
      <p className="small muted">Planilhas com empréstimos (saldo, juros, situação), pagamentos e clientes.</p>
      <div className="flex mb">
        <button className="btn primary" onClick={() => dl('/api/lending/export.xlsx', `emprestimos-${d}.xlsx`)}>Baixar Excel (.xlsx)</button>
        <button className="btn" onClick={() => dl('/api/lending/export.csv?kind=loans', `emprestimos-${d}.csv`)}>CSV de empréstimos</button>
        <button className="btn" onClick={() => dl('/api/lending/export.csv?kind=payments', `pagamentos-${d}.csv`)}>CSV de pagamentos</button>
        <button className="btn" onClick={() => dl('/api/lending/export.csv?kind=clients', `clientes-${d}.csv`)}>CSV de clientes</button>
      </div>
      {can('settings.manage') && (
        <>
          <h3 className="mt">Backup</h3>
          <p className="small muted">Cópia completa (clientes, empréstimos, pagamentos, contratos e configurações) em um arquivo. Guarde em local seguro: contém dados pessoais dos clientes.</p>
          <button className="btn" onClick={() => dl('/api/lending/backup.json', `backup-${d}.json`)}>Baixar backup completo</button>
        </>
      )}
    </div>
  );
}

export function AppearanceTab() {
  const [t, setT] = useState<Theme>(getTheme());
  const choose = (x: Theme) => { setTheme(x); setT(x); };
  return (
    <div className="card">
      <h3>Aparência</h3>
      <div className="option-cards">
        <button className={`option-card ${t === 'light' ? 'active' : ''}`} onClick={() => choose('light')}><strong>Claro</strong><span>Fundo claro (padrão)</span></button>
        <button className={`option-card ${t === 'dark' ? 'active' : ''}`} onClick={() => choose('dark')}><strong>Escuro</strong><span>Melhor à noite</span></button>
      </div>
    </div>
  );
}

/** Funções completas da plataforma (parcelas pré-calculadas, cobranças automáticas, relatórios etc.). */
export function MoreTab() {
  const { can, logout, user } = useAuth();
  const links: Array<[string, string, boolean]> = [
    ['/app/simulador', 'Simulador de empréstimo', true],
    ['/app/relatorios', 'Relatórios e fechamento mensal', can('reports.view')],
    ['/app/recebimentos', 'Recebimentos e conciliação', can('installments.view')],
    ['/app/emprestimos/parcelados', 'Empréstimos com parcelas pré-calculadas (Price/SAC)', can('loans.view')],
    ['/app/parcelas', 'Parcelas (empréstimos pré-calculados)', can('installments.view')],
    ['/app/contratos', 'Modelos e contratos (empréstimos pré-calculados)', can('loans.view')],
    ['/app/cobrancas', 'Central de cobranças automáticas', can('collections.manage')],
    ['/app/auditoria', 'Registro de ações', can('audit.view')],
  ];
  return (
    <>
      <div className="list mb">
        {links.filter((l) => l[2]).map(([to, label]) => <Link key={to} className="list-item" to={to}><span className="title">{label}</span><span className="muted">›</span></Link>)}
      </div>
      <div className="card"><div className="flex between"><span className="muted">Conectado como <strong>{user?.name}</strong></span><button className="btn" onClick={logout}>Sair</button></div></div>
    </>
  );
}
