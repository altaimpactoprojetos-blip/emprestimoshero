import type React from "react";
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { Loading } from './components/ui';
import { LoginPage, ForgotPasswordPage, ResetPasswordPage } from './pages/auth/LoginPage';
import { PlatformOverview, PlatformCompanies, PlatformCompanyDetail, PlatformPlans, PlatformInvoices } from './pages/platform/PlatformPages';
import { SettingsPage } from './pages/app/SettingsPages';
import { AuditPage } from './pages/app/AuditPage';
import { appRoutes, appNav } from './pages/app/index';
import { portalRoutes, PortalShell, PortalLoginPage } from './pages/portal/index';

function Home() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'PLATFORM_OWNER') return <Navigate to="/plataforma" replace />;
  if (user.role === 'CLIENT') return <Navigate to={`/portal/${user.company?.slug}`} replace />;
  return <Navigate to="/app" replace />;
}

function RequireRole({ roles, children }: { roles: string[]; children: React.ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function PortalForgot() { const { slug } = useParams(); return <ForgotPasswordPage portalSlug={slug} />; }
function PortalReset() { const { slug } = useParams(); return <ResetPasswordPage portalSlug={slug} />; }

export function AppRoutes() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-page"><Loading text="Carregando sessão..." /></div>;
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={user && user.role !== 'CLIENT' ? <Home /> : <LoginPage />} />
      <Route path="/recuperar-senha" element={<ForgotPasswordPage />} />
      <Route path="/redefinir-senha" element={<ResetPasswordPage />} />

      <Route path="/plataforma" element={<RequireRole roles={['PLATFORM_OWNER']}><AppShell brandTitle="Plataforma" brandSub="Painel do proprietário" groups={[{ items: [{ to: '/plataforma', label: 'Visão geral', end: true }, { to: '/plataforma/empresas', label: 'Empresas' }, { to: '/plataforma/planos', label: 'Planos' }, { to: '/plataforma/faturas', label: 'Faturas das assinaturas' }] }]} /></RequireRole>}>
        <Route index element={<PlatformOverview />} />
        <Route path="empresas" element={<PlatformCompanies />} />
        <Route path="empresas/:id" element={<PlatformCompanyDetail />} />
        <Route path="planos" element={<PlatformPlans />} />
        <Route path="faturas" element={<PlatformInvoices />} />
      </Route>

      <Route path="/app" element={<RequireRole roles={['COMPANY_ADMIN', 'FINANCE', 'COLLECTION']}><AppShell brandTitle={user?.company?.name ?? 'Empresa'} brandSub="Gestão de empréstimos" logoUrl={user?.company?.logoFileId ? `/api/company/public/${user.company.slug}/logo` : null} groups={appNav} /></RequireRole>}>
        {appRoutes}
        <Route path="configuracoes" element={<SettingsPage />} />
        <Route path="auditoria" element={<AuditPage />} />
      </Route>

      <Route path="/portal/:slug/login" element={<PortalLoginPage />} />
      <Route path="/portal/:slug/recuperar-senha" element={<PortalForgot />} />
      <Route path="/portal/:slug/redefinir-senha" element={<PortalReset />} />
      <Route path="/portal/:slug" element={<PortalShell />}>{portalRoutes}</Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
