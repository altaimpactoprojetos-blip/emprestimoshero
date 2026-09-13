import type { Tx } from './prisma.js';

/** Próximo número sequencial por empresa e chave (ex.: LOAN, RECEIPT), seguro em transação. */
export async function nextNumber(tx: Tx, companyId: string, key: string): Promise<number> {
  const row = await tx.counter.upsert({
    where: { companyId_key: { companyId, key } },
    create: { companyId, key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return row.value;
}
