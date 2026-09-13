import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, openFile } from '../../lib/api';
import { brl, dateBR, dateTimeBR, todayISO, pct } from '../../lib/format';
import { INSTALLMENT_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, CALC_METHOD, PERIODICITY } from '../../lib/labels';
import type { Installment, Loan, Payment } from '../../lib/types';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, StatusBadge, EmptyState, Modal, Field, useToast, errorMessage, Alert, KV, Badge, Confirm } from '../../components/ui';

const methods = Object.entries(PAYMENT_METHOD);

/** Modal de recebimento (integral ou parcial) de uma parcela. */
export function ReceiveModal({ inst, loan, onClose, onDone }: { inst: Installment; loan: Pick<Loan, 'id' | 'number'>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [amount, setAmount] = useState(inst.balance.totalDue);
  const [discount, setDiscount] = useState('0');
  const [method, setMethod] = useState('PIX');
  const [paidAt, setPaidAt] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      let proofFileId: string | null = null;
      if (file) { const fd = new FormData(); fd.append('file', file); proofFileId = (await api<{ fileId: string }>('payments/proof-upload', { formData: fd })).fileId; }
      return api<Payment>('payments', { body: { installmentId: inst.id, amount, discount: discount || '0', method, paidAt, notes: notes || null, proofFileId } });
    },
    onSuccess: (p) => { toast(`Pagamento registrado. Recibo nº ${p.receiptNumber}`, 'success'); onDone(); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remaining = Number(inst.balance.totalDue) - Number(amount || 0) - Number(discount || 0);
  return (
    <Modal title={`Receber parcela ${inst.number} — empréstimo nº ${loan.number}`} onClose={onClose}>
      <KV items={[['Vencimento', dateBR(inst.dueDate)], ['Valor original', brl(inst.originalAmount)], ['Já pago', brl(Number(inst.paidPrincipal) + Number(inst.paidInterest) + Number(inst.paidCharges))], ['Encargos de atraso', `${brl(inst.balance.chargesDue)}${inst.balance.daysLate ? ` (${inst.balance.daysLate} dias)` : ''}`], ['Saldo da parcela', <strong>{brl(inst.balance.totalDue)}</strong>]]} />
      <Alert kind="info">Os valores são calculados na data informada. O recebimento é destinado na ordem: encargos de atraso, juros e principal.</Alert>
      <div className="form-row">
        <Field label="Valor recebido (R$)"><input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Data do pagamento"><input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
        <Field label="Forma de pagamento"><select value={method} onChange={(e) => setMethod(e.target.value)}>{methods.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {can('discounts.grant') && <Field label="Desconto concedido (R$)"><input type="number" step="0.01" min="0" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>}
      </div>
      <Field label="Comprovante (opcional)"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <Field label="Observações"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {remaining > 0.004 && <Alert kind="warning">Pagamento parcial: restarão {brl(remaining)} nesta parcela, que continuará em aberto com encargos recalculados.</Alert>}
      {remaining < -0.004 && <Alert kind="error">O valor excede o saldo da parcela.</Alert>}
      <div className="form-actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={save.isPending || remaining < -0.004} onClick={() => save.mutate()}>{save.isPending ? 'Registrando...' : 'Confirmar recebimento'}</button></div>
    </Modal>
  );
}

function PayoffModal({ loan, onClose, onDone }: { loan: Loan; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [asOf, setAsOf] = useState(todayISO());
  const [method, setMethod] = useState('PIX');
  const [extra, setExtra] = useState('0');
  const q = useQuery({ queryKey: ['payoff', loan.id, asOf], queryFn: () => api<{ asOf: string; items: Array<{ installmentId: string; number: number; dueDate: string; principal: string; interest: string; charges: string; waivedInterest: string; total: string }>; totals: Record<string, string> }>(`payments/payoff/${loan.id}?asOf=${asOf}`) });
  const run = useMutation({ mutationFn: () => api(`payments/payoff/${loan.id}`, { body: { paidAt: asOf, method, extraDiscount: extra || '0' } }), onSuccess: () => { toast('Empréstimo quitado', 'success'); onDone(); onClose(); }, onError: (e) => toast(errorMessage(e), 'error') });
  return (
    <Modal title={`Quitação antecipada — empréstimo nº ${loan.number}`} onClose={onClose} wide>
      <div className="form-row cols-3">
        <Field label="Data da quitação"><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Field label="Forma de pagamento"><select value={method} onChange={(e) => setMethod(e.target.value)}>{methods.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {can('discounts.grant') && <Field label="Desconto adicional (R$)"><input type="number" step="0.01" value={extra} onChange={(e) => setExtra(e.target.value)} /></Field>}
      </div>
      {q.isLoading ? <p className="muted">Calculando...</p> : q.error ? <Alert kind="error">{errorMessage(q.error)}</Alert> : q.data && (
        <>
          <Alert kind="info">Regra: parcelas vencidas são cobradas integralmente com encargos; parcelas a vencer pagam o principal integral e apenas os juros proporcionais aos dias decorridos do período (pro rata), com dispensa do restante.</Alert>
          <div className="table-wrap"><table className="table"><thead><tr><th>Parcela</th><th>Vencimento</th><th className="num">Principal</th><th className="num">Juros devidos</th><th className="num">Encargos</th><th className="num">Juros dispensados</th><th className="num">Total</th></tr></thead><tbody>
            {q.data.items.map((i) => <tr key={i.installmentId}><td>{i.number}</td><td>{i.dueDate}</td><td className="num">{brl(i.principal)}</td><td className="num">{brl(i.interest)}</td><td className="num">{brl(i.charges)}</td><td className="num">{brl(i.waivedInterest)}</td><td className="num">{brl(i.total)}</td></tr>)}
            <tr className="total-row"><td colSpan={2}>Total</td><td className="num">{brl(q.data.totals.principal)}</td><td className="num">{brl(q.data.totals.interest)}</td><td className="num">{brl(q.data.totals.charges)}</td><td className="num">{brl(q.data.totals.waivedInterest)}</td><td className="num">{brl(q.data.totals.total)}</td></tr>
          </tbody></table></div>
          <h3 className="mt right">Valor para quitação: {brl(Number(q.data.totals.total) - Number(extra || 0))}</h3>
        </>
      )}
      <div className="form-actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={run.isPending || !q.data} onClick={() => run.mutate()}>Confirmar quitação</button></div>
    </Modal>
  );
}

function RenegotiateModal({ loan, onClose, onDone }: { loan: Loan; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const open = loan.installments.filter((i) => ['PENDING', 'PARTIAL'].includes(i.status));
  const [selected, setSelected] = useState<string[]>(open.map((i) => i.id));
  const [asOf, setAsOf] = useState(todayISO());
  const [discount, setDiscount] = useState('0');
  const [terms, setTerms] = useState({ installmentsCount: 6, periodicity: 'MONTHLY', firstDueDate: '', calcMethod: 'PRICE', monthlyRate: loan.monthlyRate, lateFineRate: loan.lateFineRate, lateInterestMonthly: loan.lateInterestMonthly, notes: '' });
  useEffect(() => { const d = new Date(); d.setMonth(d.getMonth() + 1); setTerms((t) => ({ ...t, firstDueDate: d.toISOString().slice(0, 10) })); }, []);
  const preview = useQuery({ queryKey: ['reneg', loan.id, selected, asOf, discount], enabled: selected.length > 0, queryFn: () => api<{ balanceBefore: string; discount: string; balanceRenegotiated: string; balances: Array<{ installmentId: string; number: number; balance: { totalDue: string; daysLate: number } }> }>(`payments/renegotiate/${loan.id}/preview`, { body: { installmentIds: selected, asOf, discount: discount || '0' } }) });
  const run = useMutation({
    mutationFn: () => api<{ newLoan: { id: string; number: number } }>(`payments/renegotiate/${loan.id}`, { body: { installmentIds: selected, asOf, discount: discount || '0', notes: terms.notes || null, newLoan: { installmentsCount: Number(terms.installmentsCount), periodicity: terms.periodicity, disbursementDate: asOf, firstDueDate: terms.firstDueDate, calcMethod: terms.calcMethod, monthlyRate: terms.monthlyRate, chargeMode: 'FINANCED', originationFee: '0', originationFeeRate: '0', iofFixedRate: '0', iofDailyRate: '0', lateFineRate: terms.lateFineRate, lateInterestMonthly: terms.lateInterestMonthly } } }),
    onSuccess: (r) => { toast(`Renegociação concluída. Novo empréstimo nº ${r.newLoan.number}`, 'success'); onDone(); onClose(); nav(`/app/emprestimos/${r.newLoan.id}`); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal title={`Renegociar — empréstimo nº ${loan.number}`} onClose={onClose} wide>
      <Alert kind="info">As parcelas selecionadas são encerradas como renegociadas e o saldo (com encargos até a data, menos desconto) vira o principal de um novo empréstimo vinculado. O histórico original é preservado e a dívida não é duplicada.</Alert>
      <div className="grid cols-2">
        <div>
          <h3>Parcelas a renegociar</h3>
          <table className="table"><thead><tr><th></th><th>Parcela</th><th>Vencimento</th><th className="num">Saldo</th></tr></thead><tbody>
            {open.map((i) => <tr key={i.id}><td><input type="checkbox" checked={selected.includes(i.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, i.id] : selected.filter((x) => x !== i.id))} /></td><td>{i.number}</td><td>{dateBR(i.dueDate)}</td><td className="num">{brl(i.balance.totalDue)}</td></tr>)}
          </tbody></table>
          <div className="form-row mt">
            <Field label="Data-base"><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
            {can('discounts.grant') && <Field label="Desconto (R$)"><input type="number" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>}
          </div>
          {preview.data && <KV items={[['Saldo das parcelas', brl(preview.data.balanceBefore)], ['Desconto', brl(preview.data.discount)], ['Saldo renegociado (novo principal)', <strong>{brl(preview.data.balanceRenegotiated)}</strong>]]} />}
          {preview.error && <Alert kind="error">{errorMessage(preview.error)}</Alert>}
        </div>
        <div>
          <h3>Condições do novo empréstimo</h3>
          <div className="form-row">
            <Field label="Parcelas"><input type="number" min="1" value={terms.installmentsCount} onChange={(e) => setTerms({ ...terms, installmentsCount: Number(e.target.value) })} /></Field>
            <Field label="Periodicidade"><select value={terms.periodicity} onChange={(e) => setTerms({ ...terms, periodicity: e.target.value })}>{Object.entries(PERIODICITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Primeiro vencimento"><input type="date" value={terms.firstDueDate} onChange={(e) => setTerms({ ...terms, firstDueDate: e.target.value })} /></Field>
            <Field label="Taxa (% a.m.)"><input type="number" step="0.01" value={terms.monthlyRate} onChange={(e) => setTerms({ ...terms, monthlyRate: e.target.value })} /></Field>
            <Field label="Método"><select value={terms.calcMethod} onChange={(e) => setTerms({ ...terms, calcMethod: e.target.value })}>{Object.entries(CALC_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Multa / mora (%)"><span className="flex"><input className="input" type="number" step="0.01" value={terms.lateFineRate} onChange={(e) => setTerms({ ...terms, lateFineRate: e.target.value })} /><input className="input" type="number" step="0.01" value={terms.lateInterestMonthly} onChange={(e) => setTerms({ ...terms, lateInterestMonthly: e.target.value })} /></span></Field>
          </div>
          <Field label="Observações"><textarea value={terms.notes} onChange={(e) => setTerms({ ...terms, notes: e.target.value })} /></Field>
        </div>
      </div>
      <div className="form-actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={run.isPending || selected.length === 0 || !preview.data} onClick={() => run.mutate()}>Confirmar renegociação</button></div>
    </Modal>
  );
}

export function LoanFinanceActions({ loan, onDone }: { loan: Loan; onDone: () => void }) {
  const { can } = useAuth();
  const [modal, setModal] = useState<null | 'payoff' | 'reneg'>(null);
  if (!can('renegotiate')) return null;
  return (
    <>
      <button className="btn" onClick={() => setModal('payoff')}>Quitação antecipada</button>
      <button className="btn" onClick={() => setModal('reneg')}>Renegociar</button>
      {modal === 'payoff' && <PayoffModal loan={loan} onClose={() => setModal(null)} onDone={onDone} />}
      {modal === 'reneg' && <RenegotiateModal loan={loan} onClose={() => setModal(null)} onDone={onDone} />}
    </>
  );
}

export function InstallmentsSection({ loan, onDone }: { loan: Loan; onDone: () => void }) {
  const { can } = useAuth();
  const [receiving, setReceiving] = useState<Installment | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <>
      <DataTable rows={loan.installments} emptyTitle="Sem parcelas" cardTitle={(i) => `Parcela ${i.number} · ${dateBR(i.dueDate)}`} columns={[
        { key: 'number', label: 'Nº', render: (i) => i.number },
        { key: 'dueDate', label: 'Vencimento', render: (i) => dateBR(i.dueDate) },
        { key: 'original', label: 'Valor original', num: true, render: (i) => brl(i.originalAmount) },
        { key: 'charges', label: 'Encargos', num: true, render: (i) => brl(i.balance.chargesDue) },
        { key: 'discount', label: 'Descontos', num: true, render: (i) => brl(i.discountAmount) },
        { key: 'paid', label: 'Valor pago', num: true, render: (i) => brl(Number(i.paidPrincipal) + Number(i.paidInterest) + Number(i.paidCharges)) },
        { key: 'due', label: 'Saldo restante', num: true, render: (i) => <strong>{brl(i.balance.totalDue)}</strong> },
        { key: 'late', label: 'Dias de atraso', num: true, render: (i) => i.balance.daysLate || '—' },
        { key: 'status', label: 'Situação', render: (i) => <StatusBadge map={INSTALLMENT_STATUS} value={i.balance.displayStatus} /> },
        { key: 'act', label: '', hideOnCard: false, render: (i) => (
          <span className="flex">
            {loan.status === 'ACTIVE' && ['PENDING', 'PARTIAL'].includes(i.status) && can('payments.register') && <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); setReceiving(i); }}>Receber</button>}
            <button className="btn sm" onClick={(e) => { e.stopPropagation(); setExpanded(expanded === i.id ? null : i.id); }}>{expanded === i.id ? 'Ocultar' : 'Detalhes'}</button>
          </span>
        ) },
      ]} />
      {expanded && (() => { const i = loan.installments.find((x) => x.id === expanded)!; return (
        <div className="card compact mt"><h3>Parcela {i.number} — composição</h3>
          <KV items={[['Principal / juros originais', `${brl(i.principalAmount)} / ${brl(i.interestAmount)}`], ['Principal em aberto', brl(i.balance.principalOpen)], ['Juros em aberto', brl(i.balance.interestOpen)], ['Multa', `${brl(i.balance.fine)}${i.fineApplied ? ' (já aplicada em pagamento anterior)' : ''}`], ['Mora acumulada', brl(i.balance.lateInterest)], ['Encargos carregados de pagamento parcial', brl(i.balance.chargesCarried)], ['Pago (principal / juros / encargos)', `${brl(i.paidPrincipal)} / ${brl(i.paidInterest)} / ${brl(i.paidCharges)}`], ['Último pagamento', dateBR(i.lastPaymentAt)], ['Cobranças Pix/boleto', i.charges?.length ? i.charges.map((c) => `${c.type} ${c.status} ${brl(c.amount)}`).join('; ') : 'nenhuma']]} />
        </div>
      ); })()}
      {receiving && <ReceiveModal inst={receiving} loan={loan} onClose={() => setReceiving(null)} onDone={onDone} />}
    </>
  );
}

export function PaymentsSection({ loan, onDone }: { loan: Loan; onDone: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [reason, setReason] = useState('');
  const rev = useMutation({ mutationFn: () => api(`payments/${reversing!.id}/reverse`, { body: { reason } }), onSuccess: () => { toast('Pagamento estornado', 'success'); setReversing(null); setReason(''); onDone(); }, onError: (e) => toast(errorMessage(e), 'error') });
  if (loan.payments.length === 0) return <EmptyState title="Nenhum pagamento registrado" text="Use “Receber” na parcela para registrar um recebimento." />;
  const SOURCE: Record<string, string> = { MANUAL: 'Baixa manual', PROVIDER: 'Provedor (Pix/boleto)', CLIENT_UPLOAD: 'Comprovante do cliente', PAYOFF: 'Quitação antecipada', RENEGOTIATION: 'Renegociação' };
  return (
    <>
      <DataTable rows={loan.payments} cardTitle={(p) => `${brl(p.amount)} · parcela ${p.installment?.number}`} columns={[
        { key: 'paidAt', label: 'Data', render: (p) => dateBR(p.paidAt), sortValue: (p) => p.paidAt },
        { key: 'inst', label: 'Parcela', render: (p) => p.installment?.number },
        { key: 'amount', label: 'Valor', num: true, render: (p) => brl(p.amount) },
        { key: 'alloc', label: 'Principal / Juros / Encargos', render: (p) => <span className="small">{brl(p.principalPortion)} / {brl(p.interestPortion)} / {brl(p.chargesPortion)}</span> },
        { key: 'discount', label: 'Desconto', num: true, render: (p) => brl(p.discountAmount) },
        { key: 'method', label: 'Forma', render: (p) => PAYMENT_METHOD[p.method] },
        { key: 'source', label: 'Origem', render: (p) => SOURCE[p.source] ?? p.source },
        { key: 'status', label: 'Situação', render: (p) => <><StatusBadge map={PAYMENT_STATUS} value={p.status} />{p.reversalReason && <div className="small muted">{p.reversalReason} ({dateTimeBR(p.reversedAt)})</div>}</> },
        { key: 'by', label: 'Registrado por', render: (p) => p.receivedByName ?? '—' },
        { key: 'act', label: '', render: (p) => <span className="flex">
          {p.receiptNumber && p.status === 'CONFIRMED' && <button className="btn sm" onClick={() => openFile(`/api/payments/${p.id}/receipt`)}>Recibo {p.receiptNumber}</button>}
          {p.proofFile && <button className="btn sm" onClick={() => openFile(`/api/company/files/${p.proofFile!.id}`)}>Comprovante</button>}
          {p.status === 'CONFIRMED' && !['PAYOFF', 'RENEGOTIATION'].includes(p.source) && can('payments.reverse') && <button className="btn sm danger" onClick={() => setReversing(p)}>Estornar</button>}
        </span> },
      ]} />
      {reversing && (
        <Modal title="Estornar pagamento" onClose={() => setReversing(null)}>
          <p>O pagamento de <strong>{brl(reversing.amount)}</strong> em {dateBR(reversing.paidAt)} será marcado como estornado. O registro original é preservado e a parcela volta a refletir o saldo anterior.</p>
          <Field label="Justificativa (obrigatória)"><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setReversing(null)}>Cancelar</button><button className="btn danger" disabled={rev.isPending || reason.trim().length < 5} onClick={() => rev.mutate()}>Confirmar estorno</button></div>
        </Modal>
      )}
    </>
  );
}

/** Página “Parcelas” da empresa, com filtros por situação. */
export function InstallmentsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [filter, setFilter] = useState('open');
  const [receiving, setReceiving] = useState<(Installment & { loan: { id: string; number: number; client: { id: string; name: string; document: string } } }) | null>(null);
  const q = useQuery({ queryKey: ['installments', filter], queryFn: () => api<Array<Installment & { loan: { id: string; number: number; collectionState: string; client: { id: string; name: string; document: string } } }>>(`installments?filter=${filter}`) });
  const totals = q.data ? { count: q.data.length, due: q.data.reduce((a, i) => a + Number(i.balance.totalDue), 0) } : null;
  return (
    <>
      <div className="page-header"><div><h1>Parcelas</h1><p>Controle de vencimentos, atrasos e recebimentos.</p></div>{totals && <div className="stat"><div className="label">Total listado</div><div className="value">{brl(totals.due)}</div><div className="hint">{totals.count} parcela(s)</div></div>}</div>
      <div className="card">
        {q.isLoading ? <p className="loading">Carregando...</p> : q.error ? <Alert kind="error">{errorMessage(q.error)}</Alert> : (
          <DataTable rows={q.data!} searchKeys={(i) => `${i.loan.client.name} ${i.loan.client.document} ${i.loan.number}`} onRowClick={(i) => nav(`/app/emprestimos/${i.loanId}`)} cardTitle={(i) => `${i.loan.client.name} · parcela ${i.number}`}
            emptyTitle="Nenhuma parcela nesta situação"
            filters={<select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="open">Em aberto (todas)</option><option value="upcoming">A vencer</option><option value="next7">Próximos 7 dias</option><option value="due_today">Vencendo hoje</option><option value="overdue">Vencidas</option><option value="partial">Parcialmente pagas</option><option value="paid">Quitadas</option><option value="renegotiated">Renegociadas</option></select>}
            initialSort={{ key: 'dueDate', dir: 'asc' }}
            columns={[
              { key: 'client', label: 'Cliente', render: (i) => <><strong>{i.loan.client.name}</strong><div className="small muted">Empréstimo nº {i.loan.number}{i.loan.collectionState === 'PAUSED' && ' · cobrança pausada'}</div></>, sortValue: (i) => i.loan.client.name },
              { key: 'number', label: 'Parcela', render: (i) => i.number },
              { key: 'dueDate', label: 'Vencimento', render: (i) => dateBR(i.dueDate), sortValue: (i) => i.dueDate },
              { key: 'original', label: 'Original', num: true, render: (i) => brl(i.originalAmount) },
              { key: 'charges', label: 'Encargos', num: true, render: (i) => brl(i.balance.chargesDue) },
              { key: 'paid', label: 'Pago', num: true, render: (i) => brl(Number(i.paidPrincipal) + Number(i.paidInterest) + Number(i.paidCharges)) },
              { key: 'due', label: 'Saldo', num: true, render: (i) => <strong>{brl(i.balance.totalDue)}</strong>, sortValue: (i) => Number(i.balance.totalDue) },
              { key: 'late', label: 'Atraso', num: true, render: (i) => (i.balance.daysLate ? `${i.balance.daysLate} d` : '—'), sortValue: (i) => i.balance.daysLate },
              { key: 'status', label: 'Situação', render: (i) => <StatusBadge map={INSTALLMENT_STATUS} value={i.balance.displayStatus} /> },
              { key: 'act', label: '', render: (i) => ['PENDING', 'PARTIAL'].includes(i.status) && can('payments.register') && <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); setReceiving(i); }}>Receber</button> },
            ]} />
        )}
      </div>
      {receiving && <ReceiveModal inst={receiving} loan={receiving.loan} onClose={() => setReceiving(null)} onDone={() => q.refetch()} />}
    </>
  );
}

export { Badge, Confirm, pct };
