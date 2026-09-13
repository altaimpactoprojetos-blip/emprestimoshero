import { prisma } from './prisma.js';
import type { AuthContext } from '../middleware/auth.js';

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

const clean = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export async function audit(ctx: Partial<AuthContext> | null, input: AuditInput, tx: { auditLog: typeof prisma.auditLog } = prisma) {
  await tx.auditLog.create({
    data: {
      companyId: ctx?.companyId ?? null,
      userId: ctx?.userId ?? null,
      userName: ctx?.userName ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      before: clean(input.before) as never,
      after: clean(input.after) as never,
      ip: ctx?.ip ?? null,
    },
  });
}
