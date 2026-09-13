import type { Express } from 'express';
import { clientsRouter } from './clients/clients.routes.js';
import { loansRouter } from './loans/loans.routes.js';
import { contractsRouter } from './contracts/contracts.routes.js';
import { paymentsRouter } from './payments/payments.routes.js';
import { installmentsRouter } from './installments/installments.routes.js';

/** Módulos de negócio (clientes, empréstimos, contratos, parcelas, cobranças, relatórios, portal). */
export function registerModules(app: Express) {
  app.use('/api/clients', clientsRouter);
  app.use('/api/loans', loansRouter);
  app.use('/api/contracts', contractsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/installments', installmentsRouter);
}
