import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setAccessToken } from '../lib/api';

export interface Company { id: string; name: string; slug: string; logoFileId: string | null; primaryColor: string; secondaryColor: string; status: string; timezone: string; settings: Record<string, unknown> }
export interface User {
  id: string; name: string; email: string; role: string; companyId: string | null; clientId: string | null;
  twoFactorEnabled: boolean; mustChangePassword: boolean; permissions: string[]; company: Company | null;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ twoFactorRequired: boolean; twoFactorToken?: string }>;
  login2fa: (token: string, code: string) => Promise<void>;
  loginPortal: (slug: string, identifier: string, password: string) => Promise<void>;
  loginWithSession: (accessToken: string, user: User) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  can: (perm: string) => boolean;
}

const Ctx = createContext<AuthState>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const applyBranding = (c: Company | null) => {
    const root = document.documentElement.style;
    root.setProperty('--brand-primary', c?.primaryColor || '#0B2A4A');
    root.setProperty('--brand-secondary', c?.secondaryColor || '#1F6FB2');
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (r.ok) {
          const j = await r.json();
          setAccessToken(j.accessToken);
          setUser(j.user);
          applyBranding(j.user.company);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loginWithSession = useCallback((accessToken: string, u: User) => {
    setAccessToken(accessToken);
    setUser(u);
    applyBranding(u.company);
  }, []);

  const login: AuthState['login'] = async (email, password) => {
    const r = await api<{ twoFactorRequired?: boolean; twoFactorToken?: string; accessToken?: string; user?: User }>('auth/login', { body: { email, password } });
    if (r.twoFactorRequired) return { twoFactorRequired: true, twoFactorToken: r.twoFactorToken };
    loginWithSession(r.accessToken!, r.user!);
    return { twoFactorRequired: false };
  };
  const login2fa: AuthState['login2fa'] = async (twoFactorToken, code) => {
    const r = await api<{ accessToken: string; user: User }>('auth/login/2fa', { body: { twoFactorToken, code } });
    loginWithSession(r.accessToken, r.user);
  };
  const loginPortal: AuthState['loginPortal'] = async (companySlug, identifier, password) => {
    const r = await api<{ accessToken: string; user: User }>('auth/portal/login', { body: { companySlug, identifier, password } });
    loginWithSession(r.accessToken, r.user);
  };
  const logout = async () => {
    await api('auth/logout', { method: 'POST' }).catch(() => {});
    setAccessToken(null);
    setUser(null);
    applyBranding(null);
  };
  const refreshUser = async () => {
    const u = await api<User>('auth/me');
    setUser(u);
    applyBranding(u.company);
  };
  const can = useCallback((perm: string) => !!user && (user.role === 'COMPANY_ADMIN' || user.permissions.includes(perm)), [user]);

  const value = useMemo(() => ({ user, loading, login, login2fa, loginPortal, loginWithSession, logout, refreshUser, can }), [user, loading, can, loginWithSession]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
