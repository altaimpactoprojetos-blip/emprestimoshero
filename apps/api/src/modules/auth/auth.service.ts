import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verify as totpVerify } from 'otplib';

const checkTotp = async (code: string, secret: string) => { const r = await totpVerify({ secret, token: code, epochTolerance: 30 } as never); return Boolean((r as { valid?: boolean })?.valid); };
import { addDays, addMinutes } from 'date-fns';
import { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { badRequest, unauthorized, forbidden, notFound } from '../../lib/errors.js';
import { decrypt, encrypt, randomToken, sha256 } from '../../lib/crypto.js';
import { signAccessToken } from '../../middleware/auth.js';
import jwt from 'jsonwebtoken';
import { sendMail } from '../../services/mailer.js';
import { audit } from '../../lib/audit.js';

const STAFF_ROLES: Role[] = ['PLATFORM_OWNER', 'COMPANY_ADMIN', 'FINANCE', 'COLLECTION'];

export const hashPassword = (p: string) => bcrypt.hash(p, 10);

export function validatePasswordStrength(p: string) {
  if (p.length < 8) throw badRequest('A senha deve ter pelo menos 8 caracteres');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw badRequest('A senha deve conter letras e números');
}

async function issueSession(userId: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const raw = randomToken(48);
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256(raw), expiresAt: addDays(new Date(), config.jwtRefreshDays), ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
  });
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  const accessToken = signAccessToken({ sub: user.id, role: user.role, cid: user.companyId });
  return { accessToken, refreshToken: raw, user: await publicUser(user.id) };
}

export async function publicUser(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { company: { select: { id: true, name: true, slug: true, logoFileId: true, primaryColor: true, secondaryColor: true, status: true, timezone: true, settings: true } } },
  });
  const { loadAuthContext } = await import('../../middleware/auth.js');
  const ctx = await loadAuthContext(userId, null);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    companyId: u.companyId,
    clientId: u.clientId,
    twoFactorEnabled: u.twoFactorEnabled,
    mustChangePassword: u.mustChangePassword,
    permissions: ctx ? [...ctx.permissions] : [],
    company: u.company,
  };
}

/**
 * Login da equipe (proprietário e usuários das empresas).
 * Se o usuário tem 2FA ativo, devolve um token temporário para a segunda etapa.
 */
export async function loginStaff(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const users = await prisma.user.findMany({ where: { email: email.toLowerCase().trim(), role: { in: STAFF_ROLES }, active: true } });
  let user = null;
  for (const u of users) {
    if (await bcrypt.compare(password, u.passwordHash)) { user = u; break; }
  }
  if (!user) throw unauthorized('E-mail ou senha inválidos');
  if (user.companyId) {
    const c = await prisma.company.findUnique({ where: { id: user.companyId } });
    if (!c || c.status === 'SUSPENDED' || c.status === 'CANCELLED') throw forbidden('Empresa suspensa. Entre em contato com o suporte.');
  }
  if (user.twoFactorEnabled) {
    const tmp = jwt.sign({ sub: user.id, typ: '2fa' }, config.jwtSecret, { expiresIn: '5m' });
    return { twoFactorRequired: true as const, twoFactorToken: tmp };
  }
  const session = await issueSession(user.id, meta);
  await audit({ userId: user.id, userName: user.name, companyId: user.companyId, ip: meta.ip ?? null }, { action: 'LOGIN', entity: 'User', entityId: user.id });
  return { twoFactorRequired: false as const, ...session };
}

export async function loginTwoFactor(twoFactorToken: string, code: string, meta: { ip?: string | null; userAgent?: string | null }) {
  let payload: { sub: string; typ: string };
  try {
    payload = jwt.verify(twoFactorToken, config.jwtSecret) as never;
  } catch {
    throw unauthorized('Verificação expirada, faça login novamente');
  }
  if (payload.typ !== '2fa') throw unauthorized();
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user?.twoFactorSecret) throw unauthorized();
  if (!(await checkTotp(code, decrypt(user.twoFactorSecret)))) throw unauthorized('Código inválido');
  const session = await issueSession(user.id, meta);
  await audit({ userId: user.id, userName: user.name, companyId: user.companyId, ip: meta.ip ?? null }, { action: 'LOGIN_2FA', entity: 'User', entityId: user.id });
  return session;
}

/** Login do portal do cliente: identificado pela empresa (slug) + CPF/CNPJ ou e-mail + senha. */
export async function loginClient(companySlug: string, identifier: string, password: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const company = await prisma.company.findUnique({ where: { slug: companySlug } });
  if (!company || company.status === 'SUSPENDED' || company.status === 'CANCELLED') throw unauthorized('Acesso indisponível');
  const digits = identifier.replace(/\D/g, '');
  const client = digits.length >= 11
    ? await prisma.client.findFirst({ where: { companyId: company.id, document: digits } })
    : null;
  const user = await prisma.user.findFirst({
    where: {
      companyId: company.id,
      role: 'CLIENT',
      active: true,
      OR: [{ email: identifier.toLowerCase().trim() }, ...(client ? [{ clientId: client.id }] : [])],
    },
  });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw unauthorized('Dados de acesso inválidos');
  const session = await issueSession(user.id, meta);
  await audit({ userId: user.id, userName: user.name, companyId: company.id, ip: meta.ip ?? null }, { action: 'LOGIN_PORTAL', entity: 'User', entityId: user.id });
  return session;
}

export async function refreshSession(raw: string | undefined, meta: { ip?: string | null; userAgent?: string | null }) {
  if (!raw) throw unauthorized('Sessão inválida');
  const token = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  if (!token || token.revokedAt || token.expiresAt < new Date()) throw unauthorized('Sessão expirada');
  if (!token.user.active) throw unauthorized('Usuário inativo');
  // rotação: revoga o atual e emite outro
  await prisma.refreshToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
  return issueSession(token.userId, meta);
}

export async function logout(raw: string | undefined) {
  if (!raw) return;
  await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(raw), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function requestPasswordReset(email: string, companySlug?: string) {
  const where = companySlug
    ? { email: email.toLowerCase().trim(), company: { slug: companySlug } }
    : { email: email.toLowerCase().trim(), role: { in: STAFF_ROLES } };
  const users = await prisma.user.findMany({ where, include: { company: true } });
  // resposta sempre igual, para não revelar existência do e-mail
  for (const u of users) {
    const raw = randomToken(32);
    await prisma.passwordResetToken.create({ data: { userId: u.id, tokenHash: sha256(raw), expiresAt: addMinutes(new Date(), 60) } });
    const base = u.role === 'CLIENT' && u.company ? `${config.appUrl}/portal/${u.company.slug}/redefinir-senha` : `${config.appUrl}/redefinir-senha`;
    const link = `${base}?token=${raw}`;
    await sendMail({
      to: u.email,
      subject: `${u.company?.name ?? 'Plataforma'}: redefinição de senha`,
      text: `Olá, ${u.name}.\n\nRecebemos um pedido para redefinir sua senha. Acesse o link abaixo (válido por 60 minutos):\n${link}\n\nSe você não solicitou, ignore esta mensagem.`,
    });
  }
}

export async function resetPassword(rawToken: string, newPassword: string) {
  validatePasswordStrength(newPassword);
  const t = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!t || t.usedAt || t.expiresAt < new Date()) throw badRequest('Link inválido ou expirado');
  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: t.userId }, data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false } }),
    prisma.refreshToken.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

export async function changePassword(userId: string, current: string, next: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(current, u.passwordHash))) throw badRequest('Senha atual incorreta');
  validatePasswordStrength(next);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next), mustChangePassword: false } });
}

// ---------- Autenticação em duas etapas (TOTP) ----------

export async function twoFactorSetup(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { company: true } });
  const secret = generateSecret();
  await prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: encrypt(secret), twoFactorEnabled: false } });
  const issuer = u.company?.name ?? 'EmprestimosHero';
  return { secret, otpauthUrl: generateURI({ issuer, label: u.email, secret }) };
}

export async function twoFactorEnable(userId: string, code: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!u.twoFactorSecret) throw badRequest('Inicie a configuração antes de ativar');
  if (!(await checkTotp(code, decrypt(u.twoFactorSecret)))) throw badRequest('Código inválido');
  await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
  await audit({ userId, userName: u.name, companyId: u.companyId, ip: null }, { action: '2FA_ENABLED', entity: 'User', entityId: userId });
}

export async function twoFactorDisable(userId: string, password: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(password, u.passwordHash))) throw badRequest('Senha incorreta');
  await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
  await audit({ userId, userName: u.name, companyId: u.companyId, ip: null }, { action: '2FA_DISABLED', entity: 'User', entityId: userId });
}

export async function getUserOrThrow(id: string) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('Usuário não encontrado');
  return u;
}
