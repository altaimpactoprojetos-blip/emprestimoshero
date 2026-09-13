import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { resolvePermissions, type Permission } from '../lib/permissions.js';

export interface AuthContext {
  userId: string;
  userName: string;
  role: Role;
  companyId: string | null;
  clientId: string | null;
  permissions: Set<string>;
  ip: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  cid: string | null;
  typ: 'access';
}

export function signAccessToken(p: Omit<AccessTokenPayload, 'typ'>): string {
  return jwt.sign({ ...p, typ: 'access' }, config.jwtSecret, { expiresIn: config.jwtAccessTtl as never });
}

export async function loadAuthContext(userId: string, ip: string | null): Promise<AuthContext | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.active) return null;
  let companyPerms: string[] | null = null;
  if (user.companyId) {
    const company = await prisma.company.findUnique({ where: { id: user.companyId }, select: { status: true } });
    if (!company || company.status === 'SUSPENDED' || company.status === 'CANCELLED') return null;
    const rp = await prisma.rolePermission.findUnique({ where: { companyId_role: { companyId: user.companyId, role: user.role } } });
    companyPerms = rp?.permissions ?? null;
  }
  return {
    userId: user.id,
    userName: user.name,
    role: user.role,
    companyId: user.companyId,
    clientId: user.clientId,
    permissions: resolvePermissions(user.role, companyPerms, user.permissionGrants, user.permissionDenies),
    ip,
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(header.slice(7), config.jwtSecret) as AccessTokenPayload;
    } catch {
      throw unauthorized('Sessão expirada');
    }
    if (payload.typ !== 'access') throw unauthorized();
    const ctx = await loadAuthContext(payload.sub, req.ip ?? null);
    if (!ctx) throw unauthorized('Usuário inativo ou empresa suspensa');
    req.auth = ctx;
    next();
  } catch (e) {
    next(e);
  }
}

/** Exige que o usuário pertença a uma empresa (qualquer perfil operacional). */
export function requireCompany(req: Request, _res: Response, next: NextFunction) {
  const a = req.auth;
  if (!a) return next(unauthorized());
  if (!a.companyId || a.role === 'CLIENT' || a.role === 'PLATFORM_OWNER') return next(forbidden('Acesso restrito à equipe da empresa'));
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden());
    next();
  };
}

export function requirePermission(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const a = req.auth;
    if (!a) return next(unauthorized());
    if (!a.companyId || a.role === 'CLIENT') return next(forbidden());
    if (a.role === 'COMPANY_ADMIN') return next();
    for (const p of perms) if (!a.permissions.has(p)) return next(forbidden(`Permissão necessária: ${p}`));
    next();
  };
}

export const companyOf = (req: Request): string => {
  const cid = req.auth?.companyId;
  if (!cid) throw forbidden();
  return cid;
};
