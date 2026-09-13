import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { brl, dateBR, dateTimeBR, maskDocument, pct, todayISO } from '../../lib/format';
import { CALC_METHOD, INSTALLMENT_STATUS, LOAN_STATUS, PERIODICITY } from '../../lib/labels';
import type { Client, Loan, Product, Simulation } from '../../lib/types';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader, Loading, ErrorState, DataTable, Modal, Field, StatusBadge, useForm, useToast, errorMessage, KV, Badge, Stat, Alert, Confirm, Tabs } from '../../components/ui';
import { LoanContractsSection } from './ContractsSection';
import { InstallmentsSection, PaymentsSection, LoanFinanceActions } from './InstallmentsSection';

const EVENT_LABEL: Record<string, string> = { CREATED: 'Proposta cadastrada', CREATED_FROM_RENEGOTIATION: 'Criado por renegociação', UPDATED: 'Condições alteradas', SUBMITTED: 'Enviado para avaliação', ASSESSED: 'Avaliação registrada', APPROVED: 'Aprovado', REJECTED: 'Rejeitado', CONTRACT_GENERATED: 'Contrato gerado', CONTRACT_SENT: 'Contrato enviado para assinatura', SIGNED: 'Contrato assinado', DISBURSED: 'Crédito liberado', PAID_OFF: 'Quitado', RENEGOTIATED: 'Renegociado', CANCELLED: 'Cancelado', COLLECTION_PAUSED: 'Cobrança pausada', COLLECTION_RESUMED: 'Cobrança retomada', PAYMENT: 'Pagamento registrado', PAYMENT_REVERSED: 'Pagamento estornado' };

export function LoansPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['loans', status], queryFn: () => api<Loan[]>(`loans?status=${status}`) });
  return (
    <>
      <PageHeader title="Empréstimos" subtitle="Propostas, contratos em andamento e quitados." actions={can('loans.create') && <button className="btn primary" onClick={() => nav('/app/emprestimos/novo')}>Simular empréstimo</button>} />
      <div className="card">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : (
          <DataTable rows={q.data!} searchKeys={(l) => `${l.number} ${l.client?.name} ${l.client?.document}`} onRowClick={(l) => nav(`/app/emprestimos/${l.id}`)} cardTitle={(l) => `Nº ${l.number} · ${l.client?.name}`}
            emptyTitle="Nenhum empréstimo" emptyText="Use “Simular empréstimo” para cadastrar uma proposta."
            filters={<select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas as situações</option><option value="DRAFT,UNDER_REVIEW">Propostas em análise</option><option value="APPROVED,AWAITING_SIGNATURE,SIGNED">Aprovados (aguardando liberação)</option><option value="ACTIVE">Em andamento</option><option value="PAID">Quitados</option><option value="RENEGOTIATED">Renegociados</option><option value="REJECTED,CANCELLED">Rejeitados/cancelados</option></select>}
            initialSort={{ key: 'number', dir: 'desc' }}
            columns={[
              { key: 'number', label: 'Nº', render: (l) => <strong>{l.number}</strong>, sortValue: (l) => l.number },
              { key: 'client', label: 'Cliente', render: (l) => <>{l.client?.name}<div className="small muted">{maskDocument(l.client?.document)}</div></>, sortValue: (l) => l.client?.name },
              { key: 'status', label: 'Situação', render: (l) => <><StatusBadge map={LOAN_STATUS} value={l.status} />{l.collectionState === 'PAUSED' && <div className="small muted">Cobrança pausada</div>}</>, sortValue: (l) => l.status },
              { key: 'principal', label: 'Principal', num: true, render: (l) => brl(l.principalAmount), sortValue: (l) => Number(l.principalAmount) },
              { key: 'inst', label: 'Parcelas', render: (l) => `${l.installmentsCount}x ${brl(l.installmentAmount)}` },
              { key: 'open', label: 'Saldo devedor', num: true, render: (l) => brl(l.summary.openBalance), sortValue: (l) => Number(l.summary.openBalance) },
              { key: 'overdue', label: 'Em atraso', num: true, render: (l) => (Number(l.summary.overdueBalance) > 0 ? <span style={{ color: 'var(--danger)' }}>{brl(l.summary.overdueBalance)} ({l.summary.maxDaysLate} d)</span> : '—'), sortValue: (l) => Number(l.summary.overdueBalance) },
              { key: 'date', label: 'Liberação', render: (l) => dateBR(l.disbursedAt ?? l.disbursementDate), sortValue: (l) => l.disbursedAt ?? l.disbursementDate },
            ]} />
        )}
      </div>
    </>
  );
}

const defaultForm = { clientId: '', productId: '', requestedAmount: '', installmentsCount: 12, periodicity: 'MONTHLY', disbursementDate: todayISO(), firstDueDate: '', calcMethod: 'PRICE', monthlyRate: '', chargeMode: 'DEDUCTED', originationFee: '0', originationFeeRate: '0', iofFixedRate: '0', iofDailyRate: '0', lateFineRate: '2', lateInterestMonthly: '1', notes: '' };

function nextMonth(iso: string) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); }

export function SimulationView({ sim }: { sim: Simulation }) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? sim.schedule : sim.schedule.slice(0, 12);
  return (
    <>
      <div className="grid cols-3">
        <Stat label="Valor liberado" value={brl(sim.disbursedAmount)} hint={`Solicitado ${brl(sim.requestedAmount)}`} />
        <Stat label="Parcela" value={brl(sim.installmentAmount)} hint={`${sim.schedule.length} parcela(s)`} />
        <Stat label="Total a pagar" value={brl(sim.totalAmount)} hint={`Juros ${brl(sim.totalInterest)}`} />
      </div>
      <div className="mt"><KV items={[
        ['Principal financiado', brl(sim.principalAmount)],
        ['Tarifas', brl(sim.originationFee)],
        ['IOF', brl(sim.iofAmount)],
        ['Total de encargos', brl(sim.totalCharges)],
        ['Taxa efetiva mensal / anual', `${pct(sim.effectiveMonthlyRate)} / ${pct(sim.effectiveAnnualRate)}`],
        ['Taxa por período', pct(sim.periodRate, 4)],
        ['CET mensal / anual', `${pct(sim.cetMonthly)} / ${pct(sim.cetAnnual)}`],
      ]} /></div>
      <details className="mt"><summary style={{ cursor: 'pointer', color: 'var(--blue)' }}>Como o cálculo foi feito</summary><p className="small muted mt">{sim.explanation}</p></details>
      <div className="table-wrap mt"><table className="table"><thead><tr><th>Nº</th><th>Vencimento</th><th className="num">Principal</th><th className="num">Juros</th><th className="num">Parcela</th><th className="num">Saldo após</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.number}><td>{r.number}</td><td>{dateBR(r.dueDate)}</td><td className="num">{brl(r.principal)}</td><td className="num">{brl(r.interest)}</td><td className="num">{brl(r.amount)}</td><td className="num">{brl(r.balanceAfter)}</td></tr>)}
        <tr className="total-row"><td colSpan={2}>Total</td><td className="num">{brl(sim.principalAmount)}</td><td className="num">{brl(sim.totalInterest)}</td><td className="num">{brl(sim.totalAmount)}</td><td></td></tr>
      </tbody></table></div>
      {sim.schedule.length > 12 && <button className="btn sm mt" onClick={() => setShowAll(!showAll)}>{showAll ? 'Mostrar menos' : `Ver todas as ${sim.schedule.length} parcelas`}</button>}
    </>
  );
}

export function LoanFormPage({ editLoan }: { editLoan?: Loan }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const f = useForm({ ...defaultForm, clientId: params.get('clientId') ?? '', firstDueDate: nextMonth(todayISO()) });
  const clients = useQuery({ queryKey: ['clients', ''], queryFn: () => api<Client[]>('clients?status=ACTIVE') });
  const products = useQuery({ queryKey: ['products'], queryFn: () => api<Product[]>('loans/products') });
  const [sim, setSim] = useState<Simulation | null>(null);
  const [simError, setSimError] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (editLoan) f.setValues({ clientId: editLoan.clientId, productId: editLoan.productId ?? '', requestedAmount: editLoan.requestedAmount, installmentsCount: editLoan.installmentsCount, periodicity: editLoan.periodicity, disbursementDate: editLoan.disbursementDate.slice(0, 10), firstDueDate: editLoan.firstDueDate.slice(0, 10), calcMethod: editLoan.calcMethod, monthlyRate: editLoan.monthlyRate, chargeMode: editLoan.chargeMode, originationFee: editLoan.originationFee, originationFeeRate: '0', iofFixedRate: editLoan.iofFixedRate, iofDailyRate: editLoan.iofDailyRate, lateFineRate: editLoan.lateFineRate, lateInterestMonthly: editLoan.lateInterestMonthly, notes: editLoan.notes ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editLoan]);
  const applyProduct = (id: string) => {
    f.set('productId', id);
    const p = products.data?.find((x) => x.id === id);
    if (p) f.setValues((s) => ({ ...s, productId: id, calcMethod: p.calcMethod, monthlyRate: p.monthlyRate, chargeMode: p.chargeMode, originationFee: p.originationFee, originationFeeRate: p.originationFeeRate, iofFixedRate: p.iofFixedRate, iofDailyRate: p.iofDailyRate, lateFineRate: p.lateFineRate, lateInterestMonthly: p.lateInterestMonthly }));
  };
  const body = () => ({ ...f.values, productId: f.values.productId || null, installmentsCount: Number(f.values.installmentsCount), notes: f.values.notes || null });
  const simulate = useMutation({ mutationFn: () => api<Simulation>('loans/simulate', { body: body() }), onSuccess: (s) => { setSim(s); setSimError(''); }, onError: (e) => { setSim(null); setSimError(errorMessage(e)); } });
  const save = useMutation({
    mutationFn: () => (editLoan ? api<Loan>(`loans/${editLoan.id}`, { method: 'PUT', body: body() }) : api<Loan>('loans', { body: body() })),
    onSuccess: (l) => { toast(editLoan ? 'Condições atualizadas' : 'Proposta cadastrada', 'success'); qc.invalidateQueries({ queryKey: ['loans'] }); qc.invalidateQueries({ queryKey: ['loan', l.id] }); nav(`/app/emprestimos/${l.id}`); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const selectedProduct = products.data?.find((p) => p.id === f.values.productId);
  return (
    <>
      <PageHeader title={editLoan ? `Alterar condições — empréstimo nº ${editLoan.number}` : 'Simular empréstimo'} subtitle="Informe as condições, confira a simulação e confirme para cadastrar a proposta." />
      <div className="grid cols-2">
        <div className="card">
          <h3>Condições</h3>
          <Field label="Cliente"><select {...f.bind('clientId')} disabled={!!editLoan}><option value="">Selecione...</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name} — {maskDocument(c.document)}</option>)}</select></Field>
          <Field label="Produto (condições padrão)" help={selectedProduct ? (selectedProduct.legallyReviewed ? 'Condições com validação jurídica registrada pela empresa.' : 'Atenção: produto sem validação jurídica registrada.') : 'Opcional. Preenche taxa, encargos e regras de atraso.'}><select value={f.values.productId} onChange={(e) => applyProduct(e.target.value)}><option value="">Personalizado</option>{products.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} — {pct(p.monthlyRate)} a.m.</option>)}</select></Field>
          <div className="form-row">
            <Field label="Valor solicitado (R$)"><input type="number" step="0.01" min="0" {...f.bind('requestedAmount')} /></Field>
            <Field label="Taxa de juros (% ao mês)"><input type="number" step="0.01" min="0" {...f.bind('monthlyRate')} /></Field>
            <Field label="Quantidade de parcelas"><input type="number" min="1" max="360" {...f.bind('installmentsCount')} /></Field>
            <Field label="Periodicidade"><select {...f.bind('periodicity')}>{Object.entries(PERIODICITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Data da liberação"><input type="date" {...f.bind('disbursementDate')} /></Field>
            <Field label="Primeiro vencimento"><input type="date" {...f.bind('firstDueDate')} /></Field>
            <Field label="Método de cálculo"><select {...f.bind('calcMethod')}>{Object.entries(CALC_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Tarifas e tributos"><select {...f.bind('chargeMode')}><option value="DEDUCTED">Descontados do valor liberado</option><option value="FINANCED">Financiados (somados ao principal)</option></select></Field>
          </div>
          <details><summary style={{ cursor: 'pointer', color: 'var(--blue)', marginBottom: 8 }}>Tarifas, tributos e regras de atraso</summary>
            <div className="form-row cols-3">
              <Field label="Tarifa de abertura (R$)"><input type="number" step="0.01" {...f.bind('originationFee')} /></Field>
              <Field label="Tarifa (% do valor)"><input type="number" step="0.01" {...f.bind('originationFeeRate')} /></Field>
              <Field label="IOF fixo (%)"><input type="number" step="0.0001" {...f.bind('iofFixedRate')} /></Field>
              <Field label="IOF diário (% ao dia)"><input type="number" step="0.0001" {...f.bind('iofDailyRate')} /></Field>
              <Field label="Multa por atraso (%)"><input type="number" step="0.01" {...f.bind('lateFineRate')} /></Field>
              <Field label="Juros de mora (% ao mês)"><input type="number" step="0.01" {...f.bind('lateInterestMonthly')} /></Field>
            </div>
          </details>
          <Field label="Observações"><textarea {...f.bind('notes')} /></Field>
          <div className="form-actions"><button className="btn primary" disabled={simulate.isPending} onClick={() => simulate.mutate()}>{simulate.isPending ? 'Calculando...' : 'Simular'}</button></div>
        </div>
        <div className="card">
          <h3>Simulação</h3>
          {simError && <Alert kind="error">{simError}</Alert>}
          {!sim && !simError && <p className="muted">Preencha as condições e clique em “Simular” para ver principal, juros, encargos, CET e as parcelas.</p>}
          {sim && (
            <>
              <SimulationView sim={sim} />
              <div className="form-actions mt"><button className="btn navy" disabled={!f.values.clientId} onClick={() => setConfirm(true)}>{editLoan ? 'Salvar novas condições' : 'Confirmar e cadastrar proposta'}</button></div>
              {!f.values.clientId && <p className="small muted right">Selecione o cliente para cadastrar.</p>}
            </>
          )}
        </div>
      </div>
      {confirm && sim && <Confirm title="Confirmar condições" text={<>Cadastrar {editLoan ? 'as novas condições' : 'a proposta'} de <strong>{brl(sim.requestedAmount)}</strong> em {sim.schedule.length} parcela(s) de <strong>{brl(sim.installmentAmount)}</strong> (CET {pct(sim.cetAnnual)} a.a.)? Os valores da simulação serão os mesmos do contrato, das parcelas e dos relatórios.</>} onCancel={() => setConfirm(false)} onConfirm={() => save.mutate()} busy={save.isPending} />}
    </>
  );
}

export function LoanEditPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['loan', id], queryFn: () => api<Loan>(`loans/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={q.refetch} />;
  return <LoanFormPage editLoan={q.data} />;
}

export function LoanDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['loan', id], queryFn: () => api<Loan>(`loans/${id}`) });
  const [tab, setTab] = useState('parcelas');
  const [action, setAction] = useState<null | 'assess' | 'approve' | 'reject' | 'disburse' | 'cancel' | 'pause'>(null);
  const [notes, setNotes] = useState('');
  const [score, setScore] = useState('');
  const [date, setDate] = useState(todayISO());
  const refresh = () => { qc.invalidateQueries({ queryKey: ['loan', id] }); qc.invalidateQueries({ queryKey: ['loans'] }); qc.invalidateQueries({ queryKey: ['installments'] }); };
  const run = useMutation({
    mutationFn: (a: string) => {
      if (a === 'pause') return api(`loans/${id}/collection/pause`, { body: { reason: notes } });
      if (a === 'resume') return api(`loans/${id}/collection/resume`, { method: 'POST', body: {} });
      if (a === 'submit') return api(`loans/${id}/submit`, { method: 'POST', body: {} });
      return api(`loans/${id}/${a}`, { body: { notes: notes || undefined, score: score ? Number(score) : undefined, reason: notes || undefined, date: a === 'disburse' ? date : undefined } });
    },
    onSuccess: () => { toast('Operação registrada', 'success'); setAction(null); setNotes(''); setScore(''); refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const l = q.data;
  const totalsOpen = useMemo(() => l?.installments.filter((i) => ['PENDING', 'PARTIAL'].includes(i.status)) ?? [], [l]);
  if (q.isLoading) return <Loading />;
  if (q.error || !l) return <ErrorState error={q.error} retry={q.refetch} />;
  const st = l.status;
  const editable = ['DRAFT', 'UNDER_REVIEW', 'APPROVED'].includes(st);
  return (
    <>
      <PageHeader title={`Empréstimo nº ${l.number}`} subtitle={<><Link to={`/app/clientes/${l.clientId}`}>{l.client?.name}</Link> · {maskDocument(l.client?.document)}</> as unknown as string}
        actions={<>
          <StatusBadge map={LOAN_STATUS} value={st} />
          {st === 'DRAFT' && can('loans.create') && <button className="btn" onClick={() => run.mutate('submit')}>Enviar para avaliação</button>}
          {['DRAFT', 'UNDER_REVIEW'].includes(st) && can('loans.create') && <button className="btn" onClick={() => setAction('assess')}>Registrar avaliação</button>}
          {['DRAFT', 'UNDER_REVIEW'].includes(st) && can('loans.approve') && <button className="btn primary" onClick={() => setAction('approve')}>Aprovar</button>}
          {['DRAFT', 'UNDER_REVIEW', 'APPROVED'].includes(st) && can('loans.approve') && <button className="btn danger" onClick={() => setAction('reject')}>Rejeitar</button>}
          {['APPROVED', 'AWAITING_SIGNATURE', 'SIGNED'].includes(st) && can('loans.disburse') && <button className="btn primary" onClick={() => setAction('disburse')}>Registrar liberação</button>}
          {editable && can('loans.create') && <button className="btn" onClick={() => nav(`/app/emprestimos/${l.id}/editar`)}>Alterar condições</button>}
          {!['ACTIVE', 'PAID', 'RENEGOTIATED', 'CANCELLED', 'REJECTED'].includes(st) && can('loans.approve') && <button className="btn" onClick={() => setAction('cancel')}>Cancelar</button>}
          {st === 'ACTIVE' && can('collections.manage') && (l.collectionState === 'PAUSED' ? <button className="btn" onClick={() => run.mutate('resume')}>Retomar cobrança</button> : <button className="btn" onClick={() => setAction('pause')}>Pausar cobrança</button>)}
          {st === 'ACTIVE' && <LoanFinanceActions loan={l} onDone={refresh} />}
        </>} />
      {l.collectionState === 'PAUSED' && <Alert kind="warning">Cobrança automática pausada: {l.collectionPauseReason}</Alert>}
      {st === 'ACTIVE' && !l.summary.signedContract && <Alert kind="info">Não há contrato assinado registrado para este empréstimo.</Alert>}
      {l.parentLoan && <Alert kind="info">Originado da renegociação do empréstimo <Link to={`/app/emprestimos/${l.parentLoan.id}`}>nº {l.parentLoan.number}</Link>.</Alert>}
      {l.children && l.children.length > 0 && <Alert kind="info">Renegociado no empréstimo {l.children.map((c) => <Link key={c.id} to={`/app/emprestimos/${c.id}`}>nº {c.number}</Link>)}.</Alert>}
      <div className="grid cols-4">
        <Stat label="Saldo devedor" value={brl(l.summary.openBalance)} hint={`Principal em aberto ${brl(l.summary.principalOpen)}`} />
        <Stat label="Em atraso" value={brl(l.summary.overdueBalance)} hint={l.summary.overdueCount ? `${l.summary.overdueCount} parcela(s), até ${l.summary.maxDaysLate} dias` : 'Sem atrasos'} tone={l.summary.overdueCount ? 'danger' : 'success'} />
        <Stat label="Recebido" value={brl(l.summary.totalPaid)} hint={`Principal ${brl(l.summary.principalPaid)} · Juros ${brl(l.summary.interestPaid)} · Encargos ${brl(l.summary.chargesPaid)}`} />
        <Stat label="Parcelas pagas" value={`${l.summary.paidCount} / ${l.installmentsCount}`} hint={`${brl(l.installmentAmount)} ${PERIODICITY[l.periodicity].toLowerCase()}`} />
      </div>
      <div className="grid cols-2 mt">
        <div className="card">
          <h3>Condições financeiras</h3>
          <KV items={[['Valor solicitado', brl(l.requestedAmount)], ['Principal financiado', brl(l.principalAmount)], ['Valor liberado', brl(l.disbursedAmount)], ['Data de liberação', dateBR(l.disbursedAt ?? l.disbursementDate)], ['Parcelas', `${l.installmentsCount}x ${brl(l.installmentAmount)} (${PERIODICITY[l.periodicity]})`], ['Primeiro vencimento', dateBR(l.firstDueDate)], ['Método', CALC_METHOD[l.calcMethod]], ['Taxa efetiva', `${pct(l.effectiveMonthlyRate)} a.m. / ${pct(l.effectiveAnnualRate)} a.a.`], ['CET', `${pct(l.cetMonthly)} a.m. / ${pct(l.cetAnnual)} a.a.`], ['Tarifa / IOF', `${brl(l.originationFee)} / ${brl(l.iofAmount)} (${l.chargeMode === 'DEDUCTED' ? 'descontados' : 'financiados'})`], ['Total de juros', brl(l.totalInterest)], ['Total a pagar', brl(l.totalAmount)], ['Atraso', `Multa ${pct(l.lateFineRate)} + mora ${pct(l.lateInterestMonthly)} a.m.`], ['Produto', l.product?.name ?? 'Personalizado']]} />
          <details className="mt"><summary style={{ cursor: 'pointer', color: 'var(--blue)' }}>Método de cálculo</summary><p className="small muted mt">{l.calcExplanation}</p></details>
        </div>
        <div className="card">
          <h3>Avaliação e histórico</h3>
          {(l.assessmentNotes || l.assessmentScore != null) && <div className="alert info">Avaliação: {l.assessmentNotes} {l.assessmentScore != null && `(pontuação ${l.assessmentScore})`}</div>}
          {l.rejectedReason && <div className="alert error">Motivo da rejeição: {l.rejectedReason}</div>}
          {l.notes && <p className="small muted">Observações: {l.notes}</p>}
          <ul className="timeline">{l.events.map((e) => <li key={e.id}><strong>{EVENT_LABEL[e.type] ?? e.type}</strong>{e.data && typeof e.data === 'object' && 'notes' in e.data && e.data.notes ? <div className="small">{String(e.data.notes)}</div> : null}{e.data && 'reason' in (e.data as object) && (e.data as { reason?: string }).reason ? <div className="small">{(e.data as { reason?: string }).reason}</div> : null}<small>{dateTimeBR(e.createdAt)} · {e.userName ?? 'Sistema'}</small></li>)}</ul>
        </div>
      </div>
      <div className="card">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'parcelas', label: `Parcelas (${l.installments.length})` }, { key: 'pagamentos', label: `Pagamentos (${l.payments.length})` }, { key: 'contratos', label: `Contratos (${l.contracts.length})` }]} />
        {tab === 'parcelas' && <InstallmentsSection loan={l} onDone={refresh} />}
        {tab === 'pagamentos' && <PaymentsSection loan={l} onDone={refresh} />}
        {tab === 'contratos' && <LoanContractsSection loan={l} onDone={refresh} />}
      </div>
      {action && (
        <Modal title={{ assess: 'Registrar avaliação de crédito', approve: 'Aprovar empréstimo', reject: 'Rejeitar empréstimo', disburse: 'Registrar liberação do crédito', cancel: 'Cancelar proposta', pause: 'Pausar cobrança automática' }[action]} onClose={() => setAction(null)}>
          {action === 'disburse' && <><Alert kind={l.summary.signedContract ? 'success' : 'warning'}>{l.summary.signedContract ? 'Contrato assinado registrado.' : 'Ainda não há contrato assinado registrado. A liberação será registrada com essa observação.'}</Alert><p>Valor a liberar: <strong>{brl(l.disbursedAmount)}</strong></p><Field label="Data da liberação"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field></>}
          {action === 'assess' && <Field label="Pontuação (opcional)"><input type="number" value={score} onChange={(e) => setScore(e.target.value)} /></Field>}
          <Field label={action === 'reject' ? 'Motivo da rejeição' : action === 'pause' ? 'Motivo da pausa (contestação, renegociação em curso, etc.)' : action === 'cancel' ? 'Motivo' : 'Observações da avaliação'}><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setAction(null)}>Voltar</button><button className={`btn ${action === 'reject' || action === 'cancel' ? 'danger' : 'primary'}`} disabled={run.isPending} onClick={() => run.mutate(action)}>Confirmar</button></div>
        </Modal>
      )}
      {totalsOpen.length === 0 && st === 'ACTIVE' && <Alert kind="success">Todas as parcelas foram quitadas.</Alert>}
    </>
  );
}

export function ProductsSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['products'], queryFn: () => api<Product[]>('loans/products') });
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const f = useForm({ name: '', calcMethod: 'PRICE', monthlyRate: '', originationFee: '0', originationFeeRate: '0', iofFixedRate: '0.38', iofDailyRate: '0.0082', chargeMode: 'DEDUCTED', lateFineRate: '2', lateInterestMonthly: '1', legalNotes: '', legallyReviewed: false, active: true });
  const save = useMutation({
    mutationFn: () => { const body = { ...f.values, legalNotes: f.values.legalNotes || null }; return editing === 'new' ? api('loans/products', { body }) : api(`loans/products/${(editing as Product).id}`, { method: 'PUT', body }); },
    onSuccess: () => { toast('Produto salvo', 'success'); setEditing(null); qc.invalidateQueries({ queryKey: ['products'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const open = (p: Product | 'new') => { if (p === 'new') f.reset(); else f.setValues({ name: p.name, calcMethod: p.calcMethod, monthlyRate: p.monthlyRate, originationFee: p.originationFee, originationFeeRate: p.originationFeeRate, iofFixedRate: p.iofFixedRate, iofDailyRate: p.iofDailyRate, chargeMode: p.chargeMode, lateFineRate: p.lateFineRate, lateInterestMonthly: p.lateInterestMonthly, legalNotes: p.legalNotes ?? '', legallyReviewed: p.legallyReviewed, active: p.active }); setEditing(p); };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  return (
    <div className="card">
      <div className="card-header"><h3>Produtos de crédito</h3><button className="btn primary" onClick={() => open('new')}>Novo produto</button></div>
      <p className="muted">Condições padrão (taxa, tarifas, IOF, multa e mora) aplicadas às simulações. Registre a validação jurídica de cada produto.</p>
      <DataTable rows={q.data!} onRowClick={open} emptyTitle="Nenhum produto cadastrado" cardTitle={(p) => p.name} columns={[
        { key: 'name', label: 'Produto' }, { key: 'calcMethod', label: 'Método', render: (p) => CALC_METHOD[p.calcMethod] }, { key: 'monthlyRate', label: 'Taxa a.m.', num: true, render: (p) => pct(p.monthlyRate) },
        { key: 'fees', label: 'Tarifa / IOF', render: (p) => `${brl(p.originationFee)} + ${pct(p.originationFeeRate)} / ${pct(p.iofFixedRate, 2)} + ${pct(p.iofDailyRate, 4)}/dia` },
        { key: 'late', label: 'Atraso', render: (p) => `${pct(p.lateFineRate)} + ${pct(p.lateInterestMonthly)} a.m.` },
        { key: 'legal', label: 'Validação jurídica', render: (p) => <Badge tone={p.legallyReviewed ? 'success' : 'warning'}>{p.legallyReviewed ? 'Validado' : 'Pendente'}</Badge> },
        { key: 'active', label: 'Ativo', render: (p) => (p.active ? 'Sim' : 'Não') },
      ]} />
      {editing && (
        <Modal title={editing === 'new' ? 'Novo produto' : 'Editar produto'} onClose={() => setEditing(null)}>
          <Field label="Nome"><input {...f.bind('name')} /></Field>
          <div className="form-row cols-3">
            <Field label="Método"><select {...f.bind('calcMethod')}>{Object.entries(CALC_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Taxa (% a.m.)"><input type="number" step="0.01" {...f.bind('monthlyRate')} /></Field>
            <Field label="Encargos"><select {...f.bind('chargeMode')}><option value="DEDUCTED">Descontados</option><option value="FINANCED">Financiados</option></select></Field>
            <Field label="Tarifa (R$)"><input type="number" step="0.01" {...f.bind('originationFee')} /></Field>
            <Field label="Tarifa (%)"><input type="number" step="0.01" {...f.bind('originationFeeRate')} /></Field>
            <Field label="IOF fixo (%)"><input type="number" step="0.0001" {...f.bind('iofFixedRate')} /></Field>
            <Field label="IOF diário (%)"><input type="number" step="0.0001" {...f.bind('iofDailyRate')} /></Field>
            <Field label="Multa (%)"><input type="number" step="0.01" {...f.bind('lateFineRate')} /></Field>
            <Field label="Mora (% a.m.)"><input type="number" step="0.01" {...f.bind('lateInterestMonthly')} /></Field>
          </div>
          <Field label="Notas da validação jurídica"><textarea {...f.bind('legalNotes')} /></Field>
          <label className="check"><input type="checkbox" {...f.bindCheck('legallyReviewed')} /> Condições validadas juridicamente pela empresa</label>
          <label className="check"><input type="checkbox" {...f.bindCheck('active')} /> Produto ativo</label>
          <div className="form-actions"><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
        </Modal>
      )}
    </div>
  );
}

export { INSTALLMENT_STATUS };
