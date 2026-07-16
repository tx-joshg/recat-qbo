import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Role } from '@recat/shared';
import { useApp } from './state/AppContext';
import Nav from './components/Nav';
import Toast from './components/Toast';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Queue from './pages/Queue';
import Rules from './pages/Rules';
import Dashboard from './pages/Dashboard';
import Reports from './pages/Reports';
import Audit from './pages/Audit';
import Tags from './pages/Tags';
import Settings from './pages/Settings';
import Connect from './pages/Connect';

/** Auth gate + app chrome. Keyed wrapper remounts every screen on company switch. */
function AppLayout() {
  const { session, sessionLoading, activeCompanyId } = useApp();
  if (sessionLoading) return null;
  if (!session) return <Navigate to="/login" replace />;
  return (
    <>
      <Nav />
      <div key={activeCompanyId ?? 'no-company'}>
        <Outlet />
      </div>
    </>
  );
}

/**
 * /setup is the first-run wizard (no session yet) and the instance admin's
 * connect flow. A signed-in non-instance-admin has no business there.
 */
function SetupGate() {
  const { session, sessionLoading } = useApp();
  if (sessionLoading) return null;
  if (session && !session.isInstanceAdmin) return <Navigate to="/" replace />;
  return <Setup />;
}

/**
 * Per-company role gate (handoff §5, scoped to the active company). Viewers —
 * and members with no role in the active company — land on /dashboard;
 * categorizers can't open /settings.
 */
function Guard({ roles, children }: { roles: Role[]; children: ReactElement }) {
  const { session, role } = useApp();
  if (session) {
    const effective: Role = role ?? 'viewer';
    if (!roles.includes(effective)) {
      return <Navigate to={effective === 'viewer' ? '/dashboard' : '/'} replace />;
    }
  }
  return children;
}

/** Connecting a company is instance-level — company admins don't qualify. */
function InstanceAdminGuard({ children }: { children: ReactElement }) {
  const { session } = useApp();
  if (session && !session.isInstanceAdmin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<SetupGate />} />
        <Route element={<AppLayout />}>
          <Route
            path="/"
            element={
              <Guard roles={['admin', 'categorizer']}>
                <Queue />
              </Guard>
            }
          />
          <Route
            path="/rules"
            element={
              <Guard roles={['admin', 'categorizer']}>
                <Rules />
              </Guard>
            }
          />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/reports" element={<Reports />} />
          <Route
            path="/audit"
            element={
              <Guard roles={['admin', 'categorizer']}>
                <Audit />
              </Guard>
            }
          />
          <Route
            path="/tags"
            element={
              <Guard roles={['admin', 'categorizer']}>
                <Tags />
              </Guard>
            }
          />
          <Route
            path="/settings"
            element={
              <Guard roles={['admin']}>
                <Settings />
              </Guard>
            }
          />
          <Route
            path="/connect"
            element={
              <InstanceAdminGuard>
                <Connect />
              </InstanceAdminGuard>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toast />
    </>
  );
}
