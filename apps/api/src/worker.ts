/**
 * Worker de automações. Executa no servidor, independentemente do navegador:
 *  - cobranças automáticas (agendamento e disparo de lembretes) a cada 5 minutos;
 *  - expiração de cobranças Pix/boleto vencidas;
 *  - fechamento mensal automático (relatório do mês anterior) uma vez por dia;
 *  - backup diário do banco (pg_dump), quando disponível.
 * Pode rodar no mesmo host da API ou em processo separado: `npm run worker -w apps/api`.
 */
import cron from 'node-cron';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { runCollectionsAll } from './modules/collections/collections.service.js';

let running = false;

async function collectionsTick() {
  if (running) return;
  running = true;
  try {
    const r = await runCollectionsAll(new Date());
    const summary = Object.entries(r).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(' | ');
    if (summary) console.log(`[worker] cobranças: ${summary}`);
    const expired = await prisma.charge.updateMany({ where: { status: 'PENDING', expiresAt: { lt: new Date() } }, data: { status: 'EXPIRED' } });
    if (expired.count) console.log(`[worker] ${expired.count} cobrança(s) expirada(s)`);
  } catch (e) {
    console.error('[worker] erro no ciclo de cobranças', e);
  } finally {
    running = false;
  }
}

async function monthlyCloseTick() {
  try {
    const { closePreviousMonthForAll } = await import('./modules/reports/reports.service.js');
    const r = await closePreviousMonthForAll();
    console.log(`[worker] fechamento mensal: ${JSON.stringify(r)}`);
  } catch (e) {
    console.error('[worker] erro no fechamento mensal', e);
  }
}

async function backupTick() {
  try {
    const { runBackup } = await import('./scripts/backup.js');
    const r = await runBackup();
    console.log(`[worker] backup: ${r.file ?? r.skipped}`);
  } catch (e) {
    console.error('[worker] erro no backup', e);
  }
}

export function startWorker() {
  console.log(`[worker] iniciado. Cobranças: "${config.worker.collectionsCron}", fechamento mensal: "${config.worker.monthlyCloseCron}"`);
  cron.schedule(config.worker.collectionsCron, collectionsTick, { timezone: 'UTC' });
  cron.schedule(config.worker.monthlyCloseCron, monthlyCloseTick, { timezone: 'UTC' });
  cron.schedule('30 3 * * *', backupTick, { timezone: 'UTC' });
  void collectionsTick();
}

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  startWorker();
}
