import type { Express } from 'express';
import { clientsRouter } from './clients/clients.routes.js';
import { loansRouter } from './loans/loans.routes.js';

/** Módulos de negócio (clientes, empréstimos, contratos, parcelas, cobranças, relatórios, portal). */
export function registerModules(app: Express) {
  app.use('/api/clients', clientsRouter);
  app.use('/api/loans', loansRouter);
}
