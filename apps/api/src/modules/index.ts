import type { Express } from 'express';
import { clientsRouter } from './clients/clients.routes.js';
import { loansRouter } from './loans/loans.routes.js';
import { contractsRouter } from './contracts/contracts.routes.js';
import { paymentsRouter } from './payments/payments.routes.js';
import { installmentsRouter } from './installments/installments.routes.js';
import { collectionsRouter } from './collections/collections.routes.js';
import { chargesRouter } from './payments/charges.routes.js';
import { webhooksRouter } from './webhooks/webhooks.routes.js';
import { reportsRouter } from './reports/reports.routes.js';
import { portalRouter } from './portal/portal.routes.js';
import { lendingRouter } from './lending/lending.routes.js';

/** Módulos de negócio (clientes, empréstimos, contratos, parcelas, cobranças, relatórios, portal). */
export function registerModules(app: Express) {
  app.use('/api/clients', clientsRouter);
  app.use('/api/loans', loansRouter);
  app.use('/api/contracts', contractsRouter);
  app.use('/api/installments', installmentsRouter);
  app.use('/api/collections', collectionsRouter);
  app.use('/api/payments/charges', chargesRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api/lending', lendingRouter);
}
