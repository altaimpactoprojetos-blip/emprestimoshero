/**
 * Dados de demonstração.
 * ATENÇÃO: tudo criado aqui é fictício e identificado com o sufixo "(demonstração)".
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { addMonths } from 'date-fns';

const prisma = new PrismaClient();
const hash = (p: string) => bcrypt.hash(p, 10);

async function main() {
  const owner = await prisma.user.upsert({
    where: { companyId_email: { companyId: null as never, email: 'proprietario@plataforma.local' } },
    create: { name: 'Proprietário da Plataforma', email: 'proprietario@plataforma.local', passwordHash: await hash('Senha@123'), role: 'PLATFORM_OWNER' },
    update: {},
  }).catch(async () => {
    const existing = await prisma.user.findFirst({ where: { email: 'proprietario@plataforma.local', role: 'PLATFORM_OWNER' } });
    return existing ?? prisma.user.create({ data: { name: 'Proprietário da Plataforma', email: 'proprietario@plataforma.local', passwordHash: await hash('Senha@123'), role: 'PLATFORM_OWNER' } });
  });

  const plan = await prisma.plan.upsert({
    where: { id: 'plan-profissional' },
    create: { id: 'plan-profissional', name: 'Profissional', description: 'Até 10 usuários, cobranças automáticas e relatórios', monthlyPrice: 299, maxUsers: 10, features: { collections: true, reports: true, portal: true } },
    update: {},
  });
  await prisma.plan.upsert({
    where: { id: 'plan-essencial' },
    create: { id: 'plan-essencial', name: 'Essencial', description: 'Até 3 usuários', monthlyPrice: 149, maxUsers: 3, features: { collections: false, reports: true, portal: true } },
    update: {},
  });

  const company = await prisma.company.upsert({
    where: { slug: 'demo' },
    create: { slug: 'demo', name: 'Crédito Demonstração', legalName: 'Crédito Demonstração Ltda (demonstração)', cnpj: '12345678000195', email: 'contato@demo.local', planId: plan.id, status: 'ACTIVE', settings: { pixKey: 'pix@demo.local', paymentInstructions: 'Pague via Pix usando a chave informada ou pelo boleto gerado no portal.' } },
    update: {},
  });
  await prisma.subscription.upsert({
    where: { id: 'sub-demo' },
    create: { id: 'sub-demo', companyId: company.id, planId: plan.id, status: 'ACTIVE', monthlyPrice: plan.monthlyPrice, maxUsers: plan.maxUsers, features: plan.features as never, currentPeriodStart: new Date(), currentPeriodEnd: addMonths(new Date(), 1) },
    update: {},
  });
  await prisma.collectionSettings.upsert({ where: { companyId: company.id }, create: { companyId: company.id, enabled: true }, update: {} });

  const staff = [
    { name: 'Ana Administradora (demonstração)', email: 'admin@demo.local', role: 'COMPANY_ADMIN' as const },
    { name: 'Fábio Financeiro (demonstração)', email: 'financeiro@demo.local', role: 'FINANCE' as const },
    { name: 'Carla Cobrança (demonstração)', email: 'cobranca@demo.local', role: 'COLLECTION' as const },
  ];
  for (const s of staff) {
    await prisma.user.upsert({ where: { companyId_email: { companyId: company.id, email: s.email } }, create: { ...s, companyId: company.id, passwordHash: await hash('Senha@123') }, update: {} });
  }

  const { seedBusiness } = await import('./seed-business.js');
  await seedBusiness(prisma, company.id);

  console.log('Seed concluído.');
  console.log('Proprietário: proprietario@plataforma.local / Senha@123');
  console.log('Empresa demo (slug "demo"): admin@demo.local, financeiro@demo.local, cobranca@demo.local / Senha@123');
  console.log(`Portal do cliente: /portal/demo — CPF 111.444.777-35 / Senha@123`);
  void owner;
}

main().finally(() => prisma.$disconnect());
