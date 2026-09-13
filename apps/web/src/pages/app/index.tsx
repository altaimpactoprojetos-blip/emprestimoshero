import { Route } from 'react-router-dom';
import { PageHeader } from '../../components/ui';

/** Rotas e navegação da área da empresa (ampliadas nas próximas etapas). */
export const appNav = [
  { items: [{ to: '/app', label: 'Painel', end: true }] },
  { title: 'Administração', items: [{ to: '/app/configuracoes', label: 'Configurações' }, { to: '/app/auditoria', label: 'Registro de ações', perm: 'audit.view' }] },
];

function Dashboard() { return <PageHeader title="Painel" subtitle="Indicadores disponíveis na etapa de relatórios." />; }

export const appRoutes = <><Route index element={<Dashboard />} /></>;
