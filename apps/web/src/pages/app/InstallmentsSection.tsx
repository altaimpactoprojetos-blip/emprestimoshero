import type { Loan } from '../../lib/types';
import { brl, dateBR } from '../../lib/format';
import { INSTALLMENT_STATUS } from '../../lib/labels';
import { DataTable, StatusBadge, EmptyState } from '../../components/ui';

export function LoanFinanceActions(_p: { loan: Loan; onDone: () => void }) { return null; }

export function InstallmentsSection({ loan }: { loan: Loan; onDone: () => void }) {
  return (
    <DataTable rows={loan.installments} emptyTitle="Sem parcelas" cardTitle={(i) => `Parcela ${i.number} · ${dateBR(i.dueDate)}`} columns={[
      { key: 'number', label: 'Nº', render: (i) => i.number },
      { key: 'dueDate', label: 'Vencimento', render: (i) => dateBR(i.dueDate) },
      { key: 'original', label: 'Valor original', num: true, render: (i) => brl(i.originalAmount) },
      { key: 'charges', label: 'Encargos', num: true, render: (i) => brl(i.balance.chargesDue) },
      { key: 'discount', label: 'Descontos', num: true, render: (i) => brl(i.discountAmount) },
      { key: 'paid', label: 'Valor pago', num: true, render: (i) => brl(Number(i.paidPrincipal) + Number(i.paidInterest) + Number(i.paidCharges)) },
      { key: 'due', label: 'Saldo restante', num: true, render: (i) => brl(i.balance.totalDue) },
      { key: 'late', label: 'Dias de atraso', num: true, render: (i) => i.balance.daysLate || '—' },
      { key: 'status', label: 'Situação', render: (i) => <StatusBadge map={INSTALLMENT_STATUS} value={i.balance.displayStatus} /> },
    ]} />
  );
}

export function PaymentsSection({ loan }: { loan: Loan; onDone: () => void }) {
  if (loan.payments.length === 0) return <EmptyState title="Nenhum pagamento registrado" />;
  return <p className="muted">Detalhes dos pagamentos disponíveis na etapa 3.</p>;
}
