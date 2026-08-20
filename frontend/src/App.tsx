import type { ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout, Loading } from './components/Layout';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { PlayersPage, PlayerDetailPage } from './pages/Players';
import { RunScreen } from './pages/RunScreen';
import { InitialModePage, ChipsModePage, WeeklyModePage } from './pages/Modes';
import { TeamsPage, TeamDetailPage } from './pages/Teams';
import { AdminPage } from './pages/Admin';

function Gate({ children, admin }: { children: ReactNode; admin?: boolean }): ReactNode {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
}

export function App(): ReactNode {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Gate><DashboardPage /></Gate>} />
          <Route path="/players" element={<Gate><PlayersPage /></Gate>} />
          <Route path="/players/:uid" element={<Gate><PlayerDetailPage /></Gate>} />
          <Route path="/run" element={<Gate><RunScreen /></Gate>} />
          <Route path="/initial" element={<Gate><InitialModePage /></Gate>} />
          <Route path="/chips" element={<Gate><ChipsModePage /></Gate>} />
          <Route path="/weekly" element={<Gate><WeeklyModePage /></Gate>} />
          <Route path="/teams" element={<Gate><TeamsPage /></Gate>} />
          <Route path="/teams/:id" element={<Gate><TeamDetailPage /></Gate>} />
          <Route path="/admin" element={<Gate admin><AdminPage /></Gate>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
