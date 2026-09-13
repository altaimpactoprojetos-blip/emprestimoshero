import { Route } from 'react-router-dom';
import { ClientsPage, ClientDetailPage } from './ClientsPages';
import { LoansPage, LoanFormPage, LoanDetailPage, LoanEditPage } from './LoansPages';
import { InstallmentsPage } from './InstallmentsSection';
import { ContractsPage } from './ContractsSection';
import { CollectionsPage } from './CollectionsPage';
import { PaymentsPage } from './PaymentsPage';
import { DashboardPage } from './DashboardPage';
import { ReportsPage } from './ReportsPage';

/** Rotas e navegação da área da empresa (ampliadas nas próximas etapas). */
export const appNav = [
  { items: [{ to: '/app', label: 'Painel', end: true }] },
  { title: 'Operação', items: [{ to: '/app/clientes', label: 'Clientes', perm: 'clients.view' }, { to: '/app/emprestimos', label: 'Empréstimos', perm: 'loans.view' }, { to: '/app/contratos', label: 'Contratos', perm: 'loans.view' }, { to: '/app/parcelas', label: 'Parcelas', perm: 'installments.view' }] },
  { title: 'Financeiro', items: [{ to: '/app/recebimentos', label: 'Recebimentos e conciliação', perm: 'installments.view' }, { to: '/app/cobrancas', label: 'Central de cobranças', perm: 'collections.manage' }, { to: '/app/relatorios', label: 'Relatórios', perm: 'reports.view' }] },
  { title: 'Administração', items: [{ to: '/app/configuracoes', label: 'Configurações' }, { to: '/app/auditoria', label: 'Registro de ações', perm: 'audit.view' }] },
];

export const appRoutes = (
  <>
    <Route index element={<DashboardPage />} />
    <Route path="clientes" element={<ClientsPage />} />
    <Route path="clientes/:id" element={<ClientDetailPage />} />
    <Route path="emprestimos" element={<LoansPage />} />
    <Route path="emprestimos/novo" element={<LoanFormPage />} />
    <Route path="emprestimos/:id" element={<LoanDetailPage />} />
    <Route path="emprestimos/:id/editar" element={<LoanEditPage />} />
    <Route path="contratos" element={<ContractsPage />} />
    <Route path="parcelas" element={<InstallmentsPage />} />
    <Route path="recebimentos" element={<PaymentsPage />} />
    <Route path="cobrancas" element={<CollectionsPage />} />
    <Route path="relatorios" element={<ReportsPage />} />
  </>
);
