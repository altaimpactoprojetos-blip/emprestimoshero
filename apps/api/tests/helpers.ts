import { execSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/emprestimoshero_test?schema=public&host=/tmp';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.STORAGE_LOCAL_PATH = './storage-test';

let migrated = false;
export async function setupDb() {
  if (!migrated) {
    execSync('npx prisma migrate deploy', { stdio: 'ignore', env: process.env });
    migrated = true;
  }
  const { prisma } = await import('../src/lib/prisma.js');
  const tables = ['ReminderAttempt', 'Reminder', 'Notification', 'ClientAccessToken', 'Payment', 'Charge', 'WebhookEvent', 'IntegrationIssue', 'Renegotiation', 'ContractSigner', 'Contract', 'ContractTemplate', 'LoanEvent', 'Installment', 'ServiceRequest', 'Loan', 'LoanProduct', 'ClientDocument', 'Client', 'StoredFile', 'MessageTemplate', 'CollectionSettings', 'MonthlyReport', 'Expense', 'AuditLog', 'RefreshToken', 'PasswordResetToken', 'RolePermission', 'Counter', 'SubscriptionInvoice', 'Subscription', 'User', 'Company', 'Plan'];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
  return prisma;
}

export async function createCompanyWithAdmin(slug: string) {
  const { prisma } = await import('../src/lib/prisma.js');
  const company = await prisma.company.create({ data: { slug, name: `Empresa ${slug}`, status: 'ACTIVE' } });
  await prisma.collectionSettings.create({ data: { companyId: company.id, enabled: true } });
  const admin = await prisma.user.create({ data: { companyId: company.id, name: `Admin ${slug}`, email: `admin@${slug}.local`, passwordHash: await bcrypt.hash('Senha@123', 4), role: 'COMPANY_ADMIN' } });
  return { company, admin };
}

export async function makeApp() {
  const { createApp } = await import('../src/app.js');
  return createApp();
}

export async function login(app: ReturnType<typeof request>, email: string, password = 'Senha@123') {
  const r = await app.post('/api/auth/login').send({ email, password });
  if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${r.text}`);
  return r.body.accessToken as string;
}

export const agent = (app: unknown) => request(app as never);
