import { Route } from 'react-router-dom';
import { ClientsPage, ClientDetailPage } from './ClientsPages';
import { LoansPage, LoanFormPage, LoanEditPage } from './LoansPages';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Loading } from '../../components/ui';
import { InstallmentsPage } from './InstallmentsSection';
import { ContractsPage } from './ContractsSection';
import { CollectionsPage } from './CollectionsPage';
import { PaymentsPage } from './PaymentsPage';
import { DashboardPage } from './DashboardPage';
import { ReportsPage } from './ReportsPage';
import { HomePage } from './lending/HomePage';
import { LoansListPage } from './lending/LoansListPage';
import { BalanceLoanFormPage, SimulatorPage } from './lending/LoanForm';
import { LoanDetailRouter } from './lending/LoanDetail';
import { ContractPage } from './lending/ContractPage';

/** Rotas e navegação da área da empresa (ampliadas nas próximas etapas). */
export const appNav = [
  { items: [{ to: '/app', label: 'Painel', end: true }] },
  { title: 'Operação', items: [{ to: '/app/clientes', label: 'Clientes', perm: 'clients.view' }, { to: '/app/emprestimos', label: 'Empréstimos', perm: 'loans.view' }, { to: '/app/contratos', label: 'Contratos', perm: 'loans.view' }, { to: '/app/parcelas', label: 'Parcelas', perm: 'installments.view' }] },
  { title: 'Financeiro', items: [{ to: '/app/recebimentos', label: 'Recebimentos e conciliação', perm: 'installments.view' }, { to: '/app/cobrancas', label: 'Central de cobranças', perm: 'collections.manage' }, { to: '/app/relatorios', label: 'Relatórios', perm: 'reports.view' }] },
  { title: 'Administração', items: [{ to: '/app/configuracoes', label: 'Configurações' }, { to: '/app/auditoria', label: 'Registro de ações', perm: 'audit.view' }] },
];

export const appRoutes = (
  <>
    <Route index element={<HomePage />} />
    <Route path="painel-completo" element={<DashboardPage />} />
    <Route path="simulador" element={<SimulatorPage />} />
    <Route path="clientes" element={<ClientsPage />} />
    <Route path="clientes/:id" element={<ClientDetailPage />} />
    <Route path="emprestimos" element={<LoansListPage />} />
    <Route path="emprestimos/novo" element={<BalanceLoanFormPage />} />
    <Route path="emprestimos/parcelados" element={<LoansPage />} />
    <Route path="emprestimos/parcelados/novo" element={<LoanFormPage />} />
    <Route path="emprestimos/:id" element={<LoanDetailRouter />} />
    <Route path="emprestimos/:id/editar" element={<EditRouter />} />
    <Route path="emprestimos/:id/contrato" element={<ContractPage />} />
    <Route path="contratos" element={<ContractsPage />} />
    <Route path="parcelas" element={<InstallmentsPage />} />
    <Route path="recebimentos" element={<PaymentsPage />} />
    <Route path="cobrancas" element={<CollectionsPage />} />
    <Route path="relatorios" element={<ReportsPage />} />
  </>
);

/** Edição: empréstimos sobre saldo usam o formulário novo; os pré-calculados, o antigo. */
function EditRouter() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['loan-engine', id], queryFn: () => api<{ engine?: string }>(`loans/${id}`) });
  if (q.isLoading) return <Loading />;
  return q.data?.engine === 'BALANCE' ? <BalanceLoanFormPage /> : <LoanEditPage />;
}
