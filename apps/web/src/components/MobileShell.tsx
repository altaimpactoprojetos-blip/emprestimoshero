import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { getTheme, setTheme, type Theme } from '../lib/theme';

const icon = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const ICONS = {
  home: icon('M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10'),
  loans: icon('M3 7h18v10H3zM7 12h.01M17 12h.01M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'),
  clients: icon('M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75'),
  settings: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'),
};

/** Layout pensado para celular: topo simples e menu fixo embaixo (Início, Empréstimos, Clientes, Configurações). */
export function MobileShell({ title, logoUrl }: { title: string; logoUrl?: string | null }) {
  const loc = useLocation();
  const [theme, setT] = useState<Theme>(getTheme());
  const toggle = () => { const t = theme === 'dark' ? 'light' : 'dark'; setTheme(t); setT(t); };
  return (
    <div className="m-shell">
      <header className="m-top">
        <div className="brand">{logoUrl && <img src={logoUrl} alt="" />}<strong>{title}</strong></div>
        <button className="icon-btn" onClick={toggle} aria-label={theme === 'dark' ? 'Usar modo claro' : 'Usar modo escuro'} title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}>{theme === 'dark' ? '☀' : '☾'}</button>
      </header>
      <main className="m-content" key={loc.pathname}><Outlet /></main>
      <nav className="bottom-nav" aria-label="Menu principal">
        <NavLink to="/app" end>{ICONS.home}Início</NavLink>
        <NavLink to="/app/emprestimos">{ICONS.loans}Empréstimos</NavLink>
        <NavLink to="/app/clientes">{ICONS.clients}Clientes</NavLink>
        <NavLink to="/app/configuracoes">{ICONS.settings}Configurações</NavLink>
      </nav>
    </div>
  );
}
