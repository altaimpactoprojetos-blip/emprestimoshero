/**
 * Backup do banco com pg_dump (formato custom) e política de retenção.
 * Restauração verificável: `npm run db:restore-check -w apps/api` restaura o último backup em um banco
 * temporário e confere a contagem de tabelas/registros essenciais.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const exec = promisify(execFile);

export async function runBackup(): Promise<{ file?: string; skipped?: string }> {
  const url = process.env.DATABASE_URL;
  if (!url) return { skipped: 'DATABASE_URL ausente' };
  await fs.mkdir(config.backup.path, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.backup.path, `backup-${stamp}.dump`);
  try {
    await exec('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`, url.replace(/\?.*$/, '')], { env: { ...process.env, PGHOST: hostFromUrl(url) } });
  } catch (e) {
    return { skipped: `pg_dump indisponível ou falhou: ${(e as Error).message}` };
  }
  // retenção
  const files = (await fs.readdir(config.backup.path)).filter((f) => f.startsWith('backup-') && f.endsWith('.dump'));
  const limit = Date.now() - config.backup.retentionDays * 86400000;
  for (const f of files) {
    const st = await fs.stat(path.join(config.backup.path, f));
    if (st.mtimeMs < limit) await fs.rm(path.join(config.backup.path, f));
  }
  return { file };
}

export function hostFromUrl(url: string): string | undefined {
  const m = url.match(/[?&]host=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

if (process.argv[1]?.includes('backup')) {
  runBackup().then((r) => { console.log(r); process.exit(0); });
}
