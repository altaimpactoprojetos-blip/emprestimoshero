import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { platformRouter } from './modules/platform/platform.routes.js';
import { companyRouter } from './modules/company/company.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { registerModules } from './modules/index.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(cookieParser());
  // webhooks precisam do corpo bruto para validar assinatura HMAC
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, env: config.env, time: new Date().toISOString() }));
  app.use('/api/auth', authRouter);
  app.use('/api/platform', platformRouter);
  app.use('/api/company', companyRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/audit', auditRouter);
  registerModules(app);

  app.use((_req, res) => res.status(404).json({ error: 'Rota não encontrada', code: 'NOT_FOUND' }));
  app.use(errorHandler);
  return app;
}
