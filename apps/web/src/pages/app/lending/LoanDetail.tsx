import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, downloadFile } from '../../../lib/api';
import { brl, dateBR, dateTimeBR, maskPhone, todayISO } from '../../../lib/format';
import { BILLING_TYPE, PAYMENT_METHOD, PERIOD_STATUS, RATE_PERIOD } from '../../../lib/labels';
import type { BalanceLoan, HistoryItem, PaymentPreview } from '../../../lib/types';
import { useAuth } from '../../../auth/AuthContext';
import { Loading, ErrorState, Modal, Field, Alert, Confirm, Tabs, useToast, errorMessage, KV } from '../../../components/ui';
import { Progress, StatusPill, useDebounced } from '../../../components/lending';
import { openWhatsApp, sharePdf } from '../../../lib/share';
import { LoanDetailPage as LegacyLoanDetailPage } from '../LoansPages';
import { ContractsTab } from './ContractPage';

const EVENT_LABEL: Record<string, string> = { CREATED: 'Empréstimo cadastrado', DISBURSED: 'Dinheiro entregue', UPDATED: 'Condições alteradas', PAYMENT: 'Pagamento registrado', PAYMENT_UPDATED: 'Pagamento corrigido', PAYMENT_DELETED: 'Pagamento excluído', PAID_OFF: 'Quitado', CONTRACT_GENERATED: 'Contrato gerado', CONTRACT_DELETED: 'Contrato excluído', SIGNED: 'Contrato assinado' };

/** Decide entre a tela nova (saldo devedor) e a antiga (parcelas pré-calculadas). */
export function LoanDetailRouter() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['balance-loan', id], queryFn: () => api<BalanceLoan>(`lending/loans/${id}`), retry: false });
  if (q.isLoading) return <Loading />;
  if (q.error instanceof ApiError && q.error.status === 404) return <div className="content" style={{ padding: 0 }}><LegacyLoanDetailPage /></div>;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={q.refetch} />;
  return <BalanceLoanDetail loan={q.data} />;
}

function receiptText(loan: BalanceLoan, p: HistoryItem) {
  return `Recibo de pagamento\n${loan.client.name}\nEmpréstimo nº ${loan.number}\nData: ${dateBR(p.date)}\nValor pago: ${brl(p.amount)}\n• Juros: ${brl(p.interest)}\n• Principal: ${brl(p.principal)}${Number(p.charges) > 0 ? `\n• Multa/mora: ${brl(p.charges)}` : ''}\nSaldo devedor após o pagamento: ${brl(p.totalAfter)}`;
}

export function BalanceLoanDetail({ loan }: { loan: BalanceLoan }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState('pagamentos');
  const [paying, setPaying] = useState<HistoryItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<HistoryItem | null>(null);
  const [deletingLoan, setDeletingLoan] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<HistoryItem | null>(null);
  const L = loan.ledger;
  const refresh = () => { ['balance-loan', 'lending-loans', 'lending-dashboard', 'clients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const delPayment = useMutation({
    mutationFn: (id: string) => api(`lending/payments/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Pagamento excluído. Saldo e juros recalculados.', 'success'); setDeleting(null); refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const delLoan = useMutation({
    mutationFn: () => api(`lending/loans/${loan.id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Empréstimo excluído', 'success'); refresh(); nav('/app/emprestimos', { replace: true }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const shareReceipt = async (p: HistoryItem) => {
    try {
      const r = await sharePdf(`/api/payments/${p.id}/receipt`, `recibo-${p.receiptNumber ?? p.id}.pdf`, receiptText(loan, p), loan.client.phone);
      if (r === 'fallback') toast('Recibo baixado. Anexe o PDF na conversa do WhatsApp.', 'info');
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const visiblePeriods = L.periods.filter((p) => !p.projected || p.number <= L.termPeriods);
  return (
    <div className="has-sticky">
      <div className="section-title" style={{ marginTop: 0, alignItems: 'flex-start' }}>
        <div>
          <h1>{loan.client.name}</h1>
          <div className="small muted">Empréstimo nº {loan.number} · {BILLING_TYPE[loan.billingType]?.label} · {String(Number(loan.periodRate)).replace('.', ',')}% {RATE_PERIOD[loan.periodicity]}</div>
          {loan.client.phone && <div className="small"><a href={`tel:${loan.client.phone}`}>{maskPhone(loan.client.phone)}</a> · <button className="btn sm ghost" style={{ padding: 0 }} onClick={() => openWhatsApp(`Olá, ${loan.client.name.split(' ')[0]}!`, loan.client.phone)}>WhatsApp</button></div>}
        </div>
        <StatusPill status={L.status} />
      </div>

      <div className={`card st-${L.status}`} style={{ borderLeft: '5px solid var(--st)' }}>
        <div className="muted small">Saldo devedor hoje</div>
        <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--navy)', fontVariantNumeric: 'tabular-nums' }}>{brl(L.balance)}</div>
        {(Number(L.interestPending) > 0 || Number(L.chargesPending) > 0) && <div className="small muted">Principal {brl(L.principalOpen)} + juros pendentes {brl(L.interestPending)}{Number(L.chargesPending) > 0 ? ` + multa/mora ${brl(L.chargesPending)}` : ''}</div>}
        {L.status === 'OVERDUE' && <Alert kind="error">{brl(Number(L.overdueAmount) + Number(L.chargesPending))} em atraso há {L.daysLate} dia(s).</Alert>}
        {L.nextDue && L.status !== 'PAID' && <div className="mt">Próximo vencimento: <strong>{dateBR(L.nextDue.date)}</strong> — <strong>{brl(L.nextDue.amount)}</strong></div>}
        {L.status !== 'PAID' && <div className="small muted">Juros do próximo período sobre o saldo atual: {brl(L.nextPeriodInterest)}</div>}
        <div className="mt"><Progress value={L.progress} status={L.status} labels={[`Pago ${brl(L.totalPaid)}`, `${L.progress.toLocaleString('pt-BR')}% pago`]} /></div>
      </div>

      <div className="big-cards">
        <div className="big-card"><div className="label">Valor emprestado</div><div className="value">{brl(L.principal)}</div><div className="hint">em {dateBR(loan.disbursementDate)}</div></div>
        <div className="big-card"><div className="label">Juros acumulados</div><div className="value">{brl(L.interestAccrued)}</div>{Number(L.chargesAccrued) > 0 && <div className="hint">+ {brl(L.chargesAccrued)} de multa/mora</div>}</div>
        <div className="big-card success"><div className="label">Total pago</div><div className="value">{brl(L.totalPaid)}</div><div className="hint">Juros {brl(Number(L.interestPaid) + Number(L.chargesPaid))} · Principal {brl(L.principalPaid)}</div></div>
        <div className="big-card"><div className="label">Total a receber</div><div className="value">{brl(L.totalToReceive)}</div><div className="hint">até {dateBR(loan.maturityDate)}, se pago em dia</div></div>
      </div>

      <div className="flex mb">
        {can('contracts.manage') && <button className="btn" onClick={() => nav(`/app/emprestimos/${loan.id}/contrato`)}>Gerar contrato</button>}
        {can('loans.create') && <button className="btn" onClick={() => nav(`/app/emprestimos/${loan.id}/editar`)}>Editar</button>}
        {can('loans.approve') && <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => setDeletingLoan(true)}>Excluir</button>}
      </div>

      <div className="card">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'pagamentos', label: `Pagamentos (${loan.history.length})` }, { key: 'cronograma', label: 'Cronograma' }, { key: 'contratos', label: `Contratos (${loan.contracts.length})` }, { key: 'detalhes', label: 'Detalhes' }]} />
        {tab === 'pagamentos' && (loan.history.length === 0 ? <p className="muted">Nenhum pagamento registrado.</p> : (
          <div className="list">
            {[...loan.history].reverse().map((p) => (
              <div key={p.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="main-col">
                  <div className="title">{brl(p.amount)} <span className="meta">· {dateBR(p.date)} · {PAYMENT_METHOD[p.method] ?? p.method}</span></div>
                  <div className="meta">Juros {brl(p.interest)} · Principal {brl(p.principal)}{Number(p.charges) > 0 ? ` · Multa/mora ${brl(p.charges)}` : ''}</div>
                  <div className="meta">Saldo após o pagamento: <strong>{brl(p.totalAfter)}</strong>{Number(p.interestAfter) > 0 ? ` (principal ${brl(p.principalAfter)} + juros pendentes ${brl(p.interestAfter)})` : ''}</div>
                  {p.notes && <div className="meta">{p.notes}</div>}
                  <div className="flex" style={{ marginTop: 6 }}>
                    <button className="btn sm" onClick={() => shareReceipt(p)}>Recibo</button>
                    <button className="btn sm" onClick={() => downloadFile(`/api/payments/${p.id}/receipt`, `recibo-${p.receiptNumber}.pdf`)}>PDF</button>
                    {can('payments.reverse') && <button className="btn sm" onClick={() => setPaying(p)}>Editar</button>}
                    {can('payments.reverse') && <button className="btn sm" style={{ color: 'var(--danger)' }} onClick={() => setDeleting(p)}>Excluir</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
        {tab === 'cronograma' && (
          <div className="table-wrap"><table className="table"><thead><tr><th>Nº</th><th>Vencimento</th><th className="num">Saldo no início</th><th className="num">Juros</th><th className="num">A pagar</th><th className="num">Em aberto</th><th>Situação</th></tr></thead><tbody>
            {visiblePeriods.map((r) => <tr key={r.number}><td>{r.number}</td><td>{dateBR(r.dueDate)}</td><td className="num">{brl(r.openingPrincipal)}</td><td className="num">{brl(r.interest)}</td><td className="num">{Number(r.amountDue) > 0 ? brl(r.amountDue) : '—'}</td><td className="num">{r.status === 'ACCRUING' ? '—' : brl(r.remaining)}</td><td><StatusPill status={PERIOD_STATUS[r.status]?.st ?? 'ON_TIME'} label={PERIOD_STATUS[r.status]?.label ?? r.status} /></td></tr>)}
          </tbody></table></div>
        )}
        {tab === 'contratos' && <ContractsTab loan={loan} onChange={refresh} />}
        {tab === 'detalhes' && (
          <>
            <KV items={[
              ['Cliente', <Link key="c" to={`/app/clientes/${loan.clientId}`}>{loan.client.name}</Link>],
              ['Valor emprestado', brl(loan.principalAmount)], ['Data do empréstimo', dateBR(loan.disbursementDate)], ['Vencimento', dateBR(loan.maturityDate)],
              ['Taxa', `${String(Number(loan.periodRate)).replace('.', ',')}% ${RATE_PERIOD[loan.periodicity]}`], ['Tipo de cobrança', BILLING_TYPE[loan.billingType]?.label],
              ['Juros não pagos', loan.pendingInterestMode === 'CAPITALIZE' ? 'Somados ao principal' : 'Ficam separados'],
              ['Multa / mora', `${String(Number(loan.lateFineRate)).replace('.', ',')}% / ${String(Number(loan.lateInterestMonthly)).replace('.', ',')}% ao mês`],
              ['Entregue por', loan.disbursementMethod ?? '—'], ['Observações', loan.notes ?? '—'],
            ]} />
            <p className="small muted mt">{loan.calcExplanation}</p>
            <h3 className="mt">Histórico</h3>
            <ul className="timeline">{loan.events.map((e) => <li key={e.id}><strong>{EVENT_LABEL[e.type] ?? e.type}</strong><small>{dateTimeBR(e.createdAt)} · {e.userName ?? 'Sistema'}</small></li>)}</ul>
          </>
        )}
      </div>

      {L.status !== 'PAID' && can('payments.register') && <div className="sticky-action"><button className="btn primary" onClick={() => setPaying('new')}>Registrar pagamento</button></div>}

      {paying && <PaymentModal loan={loan} editing={paying === 'new' ? null : paying} onClose={() => setPaying(null)} onDone={(p) => { setPaying(null); refresh(); if (p) setLastReceipt(p); }} />}
      {lastReceipt && (
        <Modal title="Pagamento registrado" onClose={() => setLastReceipt(null)}>
          <Alert kind="success">Pagamento de {brl(lastReceipt.amount)} registrado. Novo saldo: {brl(lastReceipt.totalAfter)}.</Alert>
          <p>Deseja enviar o recibo ao cliente?</p>
          <div className="form-actions"><button className="btn" onClick={() => setLastReceipt(null)}>Agora não</button><button className="btn success" onClick={() => { shareReceipt(lastReceipt); setLastReceipt(null); }}>Enviar recibo pelo WhatsApp</button></div>
        </Modal>
      )}
      {deleting && <Confirm danger title="Excluir pagamento" confirmLabel="Excluir" busy={delPayment.isPending} text={<>Excluir o pagamento de <strong>{brl(deleting.amount)}</strong> de {dateBR(deleting.date)}? O saldo, os juros e os pagamentos seguintes serão recalculados.</>} onCancel={() => setDeleting(null)} onConfirm={() => delPayment.mutate(deleting.id)} />}
      {deletingLoan && <Confirm danger title="Excluir empréstimo" confirmLabel="Excluir definitivamente" busy={delLoan.isPending} text={<>Excluir o empréstimo nº {loan.number} de <strong>{loan.client.name}</strong>, com {loan.history.length} pagamento(s) e {loan.contracts.length} contrato(s)? Esta ação não pode ser desfeita.</>} onCancel={() => setDeletingLoan(false)} onConfirm={() => delLoan.mutate()} />}
    </div>
  );
}

/** Registrar ou corrigir pagamento, mostrando antes quanto vai para juros, principal e o novo saldo. */
function PaymentModal({ loan, editing, onClose, onDone }: { loan: BalanceLoan; editing: HistoryItem | null; onClose: () => void; onDone: (p: HistoryItem | null) => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(editing?.amount ?? '');
  const [paidAt, setPaidAt] = useState(editing?.date ?? (loan.today < todayISO() ? loan.today : todayISO()));
  const [method, setMethod] = useState(editing?.method ?? 'PIX');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const body = { amount, paidAt, method, notes: notes || null };
  const dBody = useDebounced(body, 300);
  const valid = Number(dBody.amount) > 0 && !!dBody.paidAt;
  const preview = useQuery({
    queryKey: ['payment-preview', loan.id, editing?.id, dBody],
    queryFn: () => api<PaymentPreview>(editing ? `lending/payments/${editing.id}/preview` : `lending/loans/${loan.id}/payments/preview`, { body: dBody }),
    enabled: valid, retry: false,
  });
  const save = useMutation({
    mutationFn: () => (editing ? api<{ payment: { id: string } }>(`lending/payments/${editing.id}`, { method: 'PUT', body }) : api<{ payment: { id: string } }>(`lending/loans/${loan.id}/payments`, { body })),
    onSuccess: (r) => {
      toast(editing ? 'Pagamento corrigido. Tudo foi recalculado.' : 'Pagamento registrado com sucesso', 'success');
      const a = preview.data?.allocation;
      onDone(!editing && a ? { id: r.payment.id, date: paidAt, amount: a.amount, charges: a.charges, interest: a.interest, principal: a.principal, principalAfter: a.principalAfter, interestAfter: a.interestAfter, chargesAfter: a.chargesAfter, totalAfter: a.totalAfter, nextPeriodInterest: a.nextPeriodInterest, method, notes, receiptNumber: null, receivedByName: null, createdAt: '' } : null);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const a = preview.data?.allocation;
  const stale = JSON.stringify(body) !== JSON.stringify(dBody) || preview.isFetching;
  return (
    <Modal title={editing ? 'Corrigir pagamento' : 'Registrar pagamento'} onClose={onClose}>
      {preview.data && <p className="small muted">Saldo antes deste pagamento: <strong>{brl(preview.data.before.balance)}</strong> (principal {brl(preview.data.before.principalOpen)} + juros {brl(preview.data.before.interestPending)}{Number(preview.data.before.chargesPending) > 0 ? ` + multa/mora ${brl(preview.data.before.chargesPending)}` : ''})</p>}
      <Field label="Valor pago (R$)"><input className="amount-input" type="number" inputMode="decimal" step="0.01" min="0" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" /></Field>
      {preview.data && !editing && <div className="flex mb"><button className="btn sm" onClick={() => setAmount(preview.data!.before.balance)}>Quitar tudo ({brl(preview.data.before.balance)})</button>{Number(preview.data.before.interestPending) > 0 && <button className="btn sm" onClick={() => setAmount(String(Number(preview.data!.before.interestPending) + Number(preview.data!.before.chargesPending)))}>Só os juros</button>}</div>}
      <div className="form-row">
        <Field label="Data do pagamento"><input type="date" max={todayISO()} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
        <Field label="Forma"><select value={method} onChange={(e) => setMethod(e.target.value)}>{['PIX', 'CASH', 'TRANSFER', 'CARD', 'OTHER'].map((k) => <option key={k} value={k}>{PAYMENT_METHOD[k]}</option>)}</select></Field>
      </div>
      {valid && preview.error && <Alert kind="error">{errorMessage(preview.error)}</Alert>}
      {a && !preview.error && (
        <div style={{ opacity: stale ? 0.6 : 1 }}>
          <div className="split">
            {Number(a.charges) > 0 && <div className="box"><div className="label">Multa e mora</div><div className="value">{brl(a.charges)}</div></div>}
            <div className="box"><div className="label">Vai para juros</div><div className="value">{brl(a.interest)}</div></div>
            <div className="box"><div className="label">Vai para o principal</div><div className="value">{brl(a.principal)}</div></div>
            <div className="box full"><div className="label">{a.paysOff ? 'Empréstimo quitado' : 'Novo saldo devedor'}</div><div className="value">{brl(a.totalAfter)}</div>{!a.paysOff && <div className="small muted">Principal {brl(a.principalAfter)}{Number(a.interestAfter) > 0 ? ` + juros pendentes ${brl(a.interestAfter)}` : ''}{Number(a.chargesAfter) > 0 ? ` + multa/mora ${brl(a.chargesAfter)}` : ''} · juros do próximo período: <strong>{brl(a.nextPeriodInterest)}</strong></div>}</div>
          </div>
          {Number(a.interestAfter) > 0 && <Alert kind="warning">O valor não cobre todos os juros: {brl(a.interestAfter)} ficam como juros pendentes ({loan.pendingInterestMode === 'CAPITALIZE' ? 'serão somados ao principal no próximo período' : 'separados do principal'}).</Alert>}
        </div>
      )}
      <Field label="Observações"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary lg" disabled={!a || !!preview.error || stale || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Salvando...' : editing ? 'Confirmar correção' : 'Confirmar pagamento'}</button>
      </div>
    </Modal>
  );
}
