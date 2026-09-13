import { Route } from 'react-router-dom';
import { PageHeader } from '../../components/ui';
import { ClientsPage, ClientDetailPage } from './ClientsPages';
import { LoansPage, LoanFormPage, LoanDetailPage, LoanEditPage } from './LoansPages';
import { InstallmentsPage } from './InstallmentsSection';
import { ContractsPage } from './ContractsSection';

/** Rotas e navegação da área da empresa (ampliadas nas próximas etapas). */
export const appNav = [
  { items: [{ to: '/app', label: 'Painel', end: true }] },
  { title: 'Operação', items: [{ to: '/app/clientes', label: 'Clientes', perm: 'clients.view' }, { to: '/app/emprestimos', label: 'Empréstimos', perm: 'loans.view' }, { to: '/app/contratos', label: 'Contratos', perm: 'loans.view' }, { to: '/app/parcelas', label: 'Parcelas', perm: 'installments.view' }] },
  { title: 'Administração', items: [{ to: '/app/configuracoes', label: 'Configurações' }, { to: '/app/auditoria', label: 'Registro de ações', perm: 'audit.view' }] },
];

function Dashboard() { return <PageHeader title="Painel" subtitle="Indicadores disponíveis na etapa de relatórios." />; }

export const appRoutes = (
  <>
    <Route index element={<Dashboard />} />
    <Route path="clientes" element={<ClientsPage />} />
    <Route path="clientes/:id" element={<ClientDetailPage />} />
    <Route path="emprestimos" element={<LoansPage />} />
    <Route path="emprestimos/novo" element={<LoanFormPage />} />
    <Route path="emprestimos/:id" element={<LoanDetailPage />} />
    <Route path="emprestimos/:id/editar" element={<LoanEditPage />} />
    <Route path="contratos" element={<ContractsPage />} />
    <Route path="parcelas" element={<InstallmentsPage />} />
  </>
);
