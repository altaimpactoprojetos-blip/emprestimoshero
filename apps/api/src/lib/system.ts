import type { AuthContext } from '../middleware/auth.js';
/** Contexto usado por automações do servidor (worker, webhooks). */
export const systemContext = (companyId: string, label = 'Sistema'): AuthContext => ({ userId: 'system', userName: label, role: 'COMPANY_ADMIN', companyId, clientId: null, permissions: new Set(['discounts.grant']), ip: null });
