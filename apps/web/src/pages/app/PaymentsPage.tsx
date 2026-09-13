import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, openFile } from '../../lib/api';
import { brl, dateBR, dateTimeBR, todayISO } from '../../lib/format';
import { PAYMENT_METHOD, PAYMENT_STATUS } from '../../lib/labels';
import type { Payment } from '../../lib/types';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader, Loading, ErrorState, DataTable, StatusBadge, useToast, errorMessage, Tabs, Stat, Alert, Modal, Field, Badge } from '../../components/ui';
import { IssuesTab } from './CollectionsPage';

type PaymentRow = Payment & { client: { id: string; name: string }; loan: { id: string; number: number }; installment: { number: number; dueDate: string }; charge: { provider: string; type: string; feeAmount: string | null; netAmount: string | null } | null };
interface ChargeRow { id: string; type: string; status: string; amount: string; feeAmount: string | null; netAmount: string | null; provider: string; externalId: string; createdAt: string; paidAt: string | null; expiresAt: string | null; payload: Record<string, string> | null; installment: { number: number; dueDate: string; loan: { id: string; number: number; client: { id: string; name: string } } }; payments: Array<{ id: string; amount: string; status: string; receiptNumber: number | null }> }

const CHARGE_STATUS: Record<string, { label: string; tone: string }> = { PENDING: { label: 'Aguardando', tone: 'info' }, PAID: { label: 'Paga', tone: 'success' }, EXPIRED: { label: 'Expirada', tone: 'neutral' }, CANCELLED: { label: 'Cancelada', tone: 'neutral' }, FAILED: { label: 'Falhou', tone: 'danger' } };
const SOURCE: Record<string, string> = { MANUAL: 'Baixa manual', PROVIDER: 'Provedor', CLIENT_UPLOAD: 'Comprovante do cliente', PAYOFF: 'Quitação', RENEGOTIATION: 'Renegociação' };

function monthStart() { return todayISO().slice(0, 8) + '01'; }

export function PaymentsPage() {
  const [tab, setTab] = useState('recebimentos');
  return (
    <>
      <PageHeader title="Recebimentos e conciliação" subtitle="Pagamentos confirmados, comprovantes a conferir, cobranças Pix/boleto e pendências de integração." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'recebimentos', label: 'Recebimentos' }, { key: 'conferencia', label: 'Comprovantes a conferir' }, { key: 'cobrancas', label: 'Cobranças Pix/boleto' }, { key: 'pendencias', label: 'Pendências' }]} />
      {tab === 'recebimentos' && <PaymentsTab />}
      {tab === 'conferencia' && <ReviewTab />}
      {tab === 'cobrancas' && <ChargesTab />}
      {tab === 'pendencias' && <IssuesTab />}
    </>
  );
}

function PaymentsTab() {
  const nav = useNavigate();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayISO());
  const q = useQuery({ queryKey: ['payments', from, to], queryFn: () => api<PaymentRow[]>(`payments?from=${from}&to=${to}`) });
  const confirmed = q.data?.filter((p) => p.status === 'CONFIRMED') ?? [];
  const sum = (f: (p: PaymentRow) => string) => confirmed.reduce((a, p) => a + Number(f(p)), 0);
  return (
    <>
      <div className="grid cols-4 mb">
        <Stat label="Recebido no período" value={brl(sum((p) => p.amount))} hint={`${confirmed.length} pagamento(s)`} tone="success" />
        <Stat label="Principal recuperado" value={brl(sum((p) => p.principalPortion))} hint="Devolução de capital, não é lucro" />
        <Stat label="Juros recebidos" value={brl(sum((p) => p.interestPortion))} />
        <Stat label="Encargos de atraso" value={brl(sum((p) => p.chargesPortion))} hint={`Descontos ${brl(sum((p) => p.discountAmount))}`} />
      </div>
      <div className="card">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : (
          <DataTable rows={q.data!} searchKeys={(p) => `${p.client.name} ${p.loan.number} ${p.receiptNumber ?? ''}`} onRowClick={(p) => nav(`/app/emprestimos/${p.loanId}`)} cardTitle={(p) => `${p.client.name} · ${brl(p.amount)}`}
            filters={<><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></>}
            emptyTitle="Nenhum pagamento no período"
            columns={[
              { key: 'paidAt', label: 'Data', render: (p) => dateBR(p.paidAt), sortValue: (p) => p.paidAt },
              { key: 'client', label: 'Cliente', render: (p) => <><strong>{p.client.name}</strong><div className="small muted">Contrato nº {p.loan.number} · parcela {p.installment.number}</div></>, sortValue: (p) => p.client.name },
              { key: 'amount', label: 'Valor', num: true, render: (p) => brl(p.amount), sortValue: (p) => Number(p.amount) },
              { key: 'alloc', label: 'Principal / Juros / Encargos', render: (p) => <span className="small">{brl(p.principalPortion)} / {brl(p.interestPortion)} / {brl(p.chargesPortion)}</span> },
              { key: 'method', label: 'Forma', render: (p) => PAYMENT_METHOD[p.method] },
              { key: 'source', label: 'Origem', render: (p) => SOURCE[p.source] ?? p.source },
              { key: 'status', label: 'Situação', render: (p) => <StatusBadge map={PAYMENT_STATUS} value={p.status} /> },
              { key: 'receipt', label: 'Recibo', render: (p) => (p.receiptNumber && p.status === 'CONFIRMED' ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); openFile(`/api/payments/${p.id}/receipt`); }}>Nº {p.receiptNumber}</button> : '—') },
            ]} />
        )}
      </div>
    </>
  );
}

function ReviewTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['payments', 'review'], queryFn: () => api<PaymentRow[]>('payments?status=PENDING_REVIEW') });
  const [decision, setDecision] = useState<{ p: PaymentRow; decision: 'approve' | 'reject'; notes: string } | null>(null);
  const review = useMutation({ mutationFn: () => api(`payments/${decision!.p.id}/review`, { body: { decision: decision!.decision, notes: decision!.notes || undefined } }), onSuccess: () => { toast('Comprovante conferido', 'success'); setDecision(null); qc.invalidateQueries({ queryKey: ['payments'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  return (
    <div className="card">
      <p className="small muted">Comprovantes enviados pelo portal ficam pendentes até a validação. Ao aprovar, o pagamento é confirmado com a data informada e o recibo é emitido.</p>
      <DataTable rows={q.data!} emptyTitle="Nenhum comprovante aguardando conferência" cardTitle={(p) => `${p.client.name} · ${brl(p.amount)}`} columns={[
        { key: 'createdAt', label: 'Enviado em', render: (p) => dateTimeBR(p.createdAt) },
        { key: 'client', label: 'Cliente', render: (p) => <><strong>{p.client.name}</strong><div className="small muted">Contrato nº {p.loan.number} · parcela {p.installment.number} (venc. {dateBR(p.installment.dueDate)})</div></> },
        { key: 'paidAt', label: 'Data informada', render: (p) => dateBR(p.paidAt) },
        { key: 'amount', label: 'Valor informado', num: true, render: (p) => brl(p.amount) },
        { key: 'notes', label: 'Observação', render: (p) => p.notes },
        { key: 'act', label: '', render: (p) => <span className="flex">{p.proofFileId && <button className="btn sm" onClick={() => openFile(`/api/company/files/${p.proofFileId}`)}>Ver comprovante</button>}{can('payments.review') && <><button className="btn sm primary" onClick={() => setDecision({ p, decision: 'approve', notes: '' })}>Aprovar</button><button className="btn sm danger" onClick={() => setDecision({ p, decision: 'reject', notes: '' })}>Rejeitar</button></>}</span> },
      ]} />
      {decision && (
        <Modal title={decision.decision === 'approve' ? 'Confirmar pagamento' : 'Rejeitar comprovante'} onClose={() => setDecision(null)}>
          <p>{decision.p.client.name} · {brl(decision.p.amount)} em {dateBR(decision.p.paidAt)}</p>
          <Field label={decision.decision === 'approve' ? 'Observação (opcional)' : 'Motivo (será exibido ao cliente no portal)'}><textarea value={decision.notes} onChange={(e) => setDecision({ ...decision, notes: e.target.value })} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setDecision(null)}>Cancelar</button><button className={`btn ${decision.decision === 'approve' ? 'primary' : 'danger'}`} disabled={review.isPending} onClick={() => review.mutate()}>Confirmar</button></div>
        </Modal>
      )}
    </div>
  );
}

function ChargesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayISO());
  const q = useQuery({ queryKey: ['charges', from, to], queryFn: () => api<{ charges: ChargeRow[]; totals: { issued: { count: number; amount: string }; paid: { count: number; amount: string; fees: string; net: string }; pending: { count: number; amount: string }; other: { count: number } }; provider: string; configured: boolean }>(`payments/charges/reconciliation?from=${from}&to=${to}`) });
  const simulate = useMutation({ mutationFn: (id: string) => api(`payments/charges/${id}/simulate-paid`, { method: 'POST', body: {} }), onSuccess: () => { toast('Pagamento simulado confirmado via webhook', 'success'); qc.invalidateQueries({ queryKey: ['charges'] }); qc.invalidateQueries({ queryKey: ['payments'] }); }, onError: (e) => toast(errorMessage(e), 'error') });
  const [view, setView] = useState<ChargeRow | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const t = q.data!.totals;
  return (
    <>
      {!q.data!.configured && <Alert kind="warning">Provedor de pagamentos em modo de demonstração ({q.data!.provider}): as cobranças Pix/boleto são simuladas e a confirmação pode ser testada com “Simular pagamento”. Configure PAYMENTS_PROVIDER no servidor para operar com um provedor real.</Alert>}
      <div className="grid cols-4 mb">
        <Stat label="Cobranças emitidas" value={brl(t.issued.amount)} hint={`${t.issued.count} cobrança(s)`} />
        <Stat label="Confirmadas" value={brl(t.paid.amount)} hint={`${t.paid.count} paga(s)`} tone="success" />
        <Stat label="Taxas do provedor" value={brl(t.paid.fees)} hint={`Líquido ${brl(t.paid.net)}`} />
        <Stat label="Aguardando pagamento" value={brl(t.pending.amount)} hint={`${t.pending.count} pendente(s) · ${t.other.count} expirada(s)/cancelada(s)`} />
      </div>
      <div className="card">
        <DataTable rows={q.data!.charges} searchKeys={(c) => `${c.installment.loan.client.name} ${c.externalId}`} onRowClick={setView} cardTitle={(c) => `${c.installment.loan.client.name} · ${c.type}`}
          filters={<><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></>}
          emptyTitle="Nenhuma cobrança emitida no período" emptyText="Emita cobranças Pix/boleto na tela do empréstimo, em “Detalhes” da parcela."
          columns={[
            { key: 'createdAt', label: 'Emitida', render: (c) => dateTimeBR(c.createdAt), sortValue: (c) => c.createdAt },
            { key: 'client', label: 'Cliente', render: (c) => <><strong>{c.installment.loan.client.name}</strong><div className="small muted">Contrato nº {c.installment.loan.number} · parcela {c.installment.number}</div></> },
            { key: 'type', label: 'Tipo', render: (c) => c.type },
            { key: 'amount', label: 'Valor', num: true, render: (c) => brl(c.amount) },
            { key: 'fee', label: 'Taxa / líquido', num: true, render: (c) => (c.feeAmount ? `${brl(c.feeAmount)} / ${brl(c.netAmount)}` : '—') },
            { key: 'status', label: 'Situação', render: (c) => <StatusBadge map={CHARGE_STATUS} value={c.status} /> },
            { key: 'paidAt', label: 'Pago em', render: (c) => dateTimeBR(c.paidAt) },
            { key: 'act', label: '', render: (c) => <span className="flex"><button className="btn sm" onClick={(e) => { e.stopPropagation(); nav(`/app/emprestimos/${c.installment.loan.id}`); }}>Contrato</button>{c.status === 'PENDING' && !q.data!.configured && can('payments.register') && <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); simulate.mutate(c.id); }}>Simular pagamento</button>}</span> },
          ]} />
      </div>
      {view && (
        <Modal title={`Cobrança ${view.type} — ${view.installment.loan.client.name}`} onClose={() => setView(null)}>
          <p><StatusBadge map={CHARGE_STATUS} value={view.status} /> <Badge>{view.provider}</Badge> <span className="mono small">{view.externalId}</span></p>
          <p>Valor {brl(view.amount)} · expira em {dateTimeBR(view.expiresAt)}</p>
          {view.payload && Object.entries(view.payload).map(([k, v]) => <div key={k}><strong className="small">{k}</strong><pre className="code">{v}</pre></div>)}
          {view.payments.length > 0 && <p className="small">Pagamentos vinculados: {view.payments.map((p) => `${brl(p.amount)} (${PAYMENT_STATUS[p.status]?.label}${p.receiptNumber ? `, recibo ${p.receiptNumber}` : ''})`).join('; ')}</p>}
        </Modal>
      )}
    </>
  );
}
