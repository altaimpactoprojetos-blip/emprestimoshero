import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors.js';
import { Prisma } from '@prisma/client';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details ?? null });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Registro duplicado', code: 'CONFLICT', details: err.meta ?? null });
    if (err.code === 'P2025') return res.status(404).json({ error: 'Registro não encontrado', code: 'NOT_FOUND' });
  }
  const anyErr = err as { status?: number; type?: string; message?: string };
  if (anyErr?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido', code: 'BAD_REQUEST' });
  console.error('[erro não tratado]', err);
  return res.status(500).json({ error: 'Erro interno do servidor', code: 'INTERNAL' });
}
