/**
 * Verificação de restauração: restaura o backup mais recente em um banco temporário,
 * confere tabelas e contagens básicas e remove o banco temporário.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { hostFromUrl } from './backup.js';

const exec = promisify(execFile);

async function main() {
  const url = process.env.DATABASE_URL!;
  const files = (await fs.readdir(config.backup.path)).filter((f) => f.endsWith('.dump')).sort();
  if (!files.length) throw new Error('Nenhum backup encontrado');
  const latest = path.join(config.backup.path, files.at(-1)!);
  const base = url.replace(/\?.*$/, '');
  const tmpDb = `restore_check_${Date.now()}`;
  const adminUrl = base.replace(/\/[^/]+$/, '/postgres');
  const tmpUrl = base.replace(/\/[^/]+$/, `/${tmpDb}`);
  const env = { ...process.env, PGHOST: hostFromUrl(url) };
  await exec('psql', [adminUrl, '-c', `CREATE DATABASE "${tmpDb}"`], { env });
  try {
    await exec('pg_restore', ['--no-owner', `--dbname=${tmpUrl}`, latest], { env });
    const { stdout } = await exec('psql', [tmpUrl, '-tAc', `SELECT (SELECT count(*) FROM "Company") || ' empresas, ' || (SELECT count(*) FROM "Loan") || ' empréstimos, ' || (SELECT count(*) FROM "Payment") || ' pagamentos'`], { env });
    console.log(`Restauração verificada a partir de ${path.basename(latest)}: ${stdout.trim()}`);
  } finally {
    await exec('psql', [adminUrl, '-c', `DROP DATABASE "${tmpDb}"`], { env });
  }
}

main().catch((e) => { console.error('Falha na verificação de restauração:', e.message); process.exit(1); });
