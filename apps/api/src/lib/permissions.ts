import { Role } from '@prisma/client';

export const PERMISSIONS = [
  'clients.view',
  'clients.manage',
  'loans.view',
  'loans.create',
  'loans.approve',
  'loans.disburse',
  'contracts.manage',
  'installments.view',
  'payments.register',
  'payments.reverse',
  'payments.review',
  'discounts.grant',
  'renegotiate',
  'collections.manage',
  'reports.view',
  'data.export',
  'users.manage',
  'settings.manage',
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'clients.view': 'Visualizar clientes',
  'clients.manage': 'Cadastrar e editar clientes',
  'loans.view': 'Visualizar empréstimos',
  'loans.create': 'Simular e cadastrar empréstimos',
  'loans.approve': 'Aprovar ou rejeitar empréstimos',
  'loans.disburse': 'Registrar liberação de crédito',
  'contracts.manage': 'Gerar e gerenciar contratos e modelos',
  'installments.view': 'Visualizar parcelas',
  'payments.register': 'Registrar pagamentos',
  'payments.reverse': 'Estornar pagamentos',
  'payments.review': 'Conferir comprovantes enviados',
  'discounts.grant': 'Conceder descontos',
  renegotiate: 'Renegociar e quitar antecipadamente',
  'collections.manage': 'Gerenciar cobranças automáticas',
  'reports.view': 'Visualizar relatórios',
  'data.export': 'Exportar dados (PDF/Excel)',
  'users.manage': 'Gerenciar usuários e permissões',
  'settings.manage': 'Configurações da empresa',
  'audit.view': 'Consultar registro de ações',
};

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  PLATFORM_OWNER: [],
  COMPANY_ADMIN: [...PERMISSIONS],
  FINANCE: [
    'clients.view',
    'clients.manage',
    'loans.view',
    'loans.create',
    'loans.disburse',
    'contracts.manage',
    'installments.view',
    'payments.register',
    'payments.reverse',
    'payments.review',
    'discounts.grant',
    'renegotiate',
    'collections.manage',
    'reports.view',
    'data.export',
  ],
  COLLECTION: ['clients.view', 'loans.view', 'installments.view', 'payments.register', 'payments.review', 'collections.manage'],
  CLIENT: [],
};

export const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_OWNER: 'Proprietário da plataforma',
  COMPANY_ADMIN: 'Administrador da empresa',
  FINANCE: 'Financeiro',
  COLLECTION: 'Atendimento/Cobrança',
  CLIENT: 'Cliente',
};

export function resolvePermissions(
  role: Role,
  companyRolePermissions: string[] | null | undefined,
  grants: string[],
  denies: string[],
): Set<string> {
  const base = new Set<string>(companyRolePermissions ?? DEFAULT_ROLE_PERMISSIONS[role]);
  for (const g of grants) base.add(g);
  for (const d of denies) base.delete(d);
  return base;
}
