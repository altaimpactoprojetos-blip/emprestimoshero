import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ROLE } from '../lib/labels';

interface NavItem { to: string; label: string; perm?: string; end?: boolean }
interface NavGroup { title?: string; items: NavItem[] }

export function AppShell({ groups, brandTitle, brandSub, logoUrl }: { groups: NavGroup[]; brandTitle: string; brandSub?: string; logoUrl?: string | null }) {
  const { user, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const visible = (i: NavItem) => !i.perm || can(i.perm);
  return (
    <div className="shell">
      <div className={`backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          {logoUrl && <img src={logoUrl} alt="" />}
          <div><strong>{brandTitle}</strong>{brandSub && <small>{brandSub}</small>}</div>
        </div>
        <nav onClick={() => setOpen(false)}>
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.title && <div className="group">{g.title}</div>}
              {g.items.filter(visible).map((i) => <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>{i.label}</NavLink>)}
            </div>
          ))}
        </nav>
        <div className="user">
          <div>{user?.name}</div>
          <small>{ROLE[user?.role ?? ''] ?? user?.role}</small>
          <button className="btn sm" onClick={logout}>Sair</button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="btn sm" onClick={() => setOpen(true)} aria-label="Abrir menu">Menu</button>
          <strong>{brandTitle}</strong>
        </div>
        <main className="content" key={loc.pathname}><Outlet /></main>
      </div>
    </div>
  );
}

export function Guard({ children, allow }: { children: ReactNode; allow: (user: NonNullable<ReturnType<typeof useAuth>['user']>) => boolean }) {
  const { user } = useAuth();
  if (!user || !allow(user)) return <div className="content"><div className="alert error">Você não tem acesso a esta área.</div></div>;
  return <>{children}</>;
}
