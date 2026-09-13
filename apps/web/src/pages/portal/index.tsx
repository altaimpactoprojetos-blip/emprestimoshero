import { Route, Outlet } from 'react-router-dom';
import { LoginPage } from '../auth/LoginPage';

export function PortalLoginPage() { return <LoginPage />; }
export function PortalShell() { return <Outlet />; }
export const portalRoutes = <Route index element={<div />} />;
