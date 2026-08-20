import { useState, type ReactNode } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/players', label: 'Players' },
  { to: '/initial', label: 'Initial XI' },
  { to: '/chips', label: 'Free Hit · Wildcard' },
  { to: '/weekly', label: 'Weekly' },
  { to: '/teams', label: 'Your Teams' },
  { to: '/run', label: 'Run' },
];

export function Layout({ children }: { children: ReactNode }): ReactNode {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const nextDeadline = (window as { __nextDeadline?: string }).__nextDeadline;

  return (
    <div>
      <div className="utility-bar">
        <div className="container utility-inner">
          <span>{nextDeadline ?? 'FPL Algorithm · The Selection Desk'}</span>
          <div className="utility-right">
            {user && (
              <span className="token-pill" data-testid="token-pill">
                CREDITS <b>{user.role === 'admin' ? '∞' : user.tokenBalance.toLocaleString()}</b>
              </span>
            )}
            {user?.role === 'admin' && <Link to="/admin">Admin</Link>}
            {user && (
              <button
                onClick={() => {
                  void logout().then(() => navigate('/login'));
                }}
              >
                Sign out ({user.name})
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="masthead">
        <div className="container" style={{ position: 'relative' }}>
          <h1 className="masthead-title">FPL ALGORITHM</h1>
          <p className="masthead-tagline">Fantasy football, decided properly.</p>
          <nav className="masthead-nav-row">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <button className="menu-toggle" onClick={() => setDrawerOpen((o) => !o)}>
            {drawerOpen ? 'Close' : 'Menu'}
          </button>
        </div>
      </div>
      <div className={`mobile-drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="container">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} onClick={() => setDrawerOpen(false)}>
              {item.label}
            </Link>
          ))}
          {user?.role === 'admin' && (
            <Link to="/admin" onClick={() => setDrawerOpen(false)}>
              Admin
            </Link>
          )}
        </div>
      </div>

      <main>{children}</main>

      <footer className="footer">
        <div className="container footer-bottom">
          <p>FPL ALGORITHM — self-hosted decision engine.</p>
          <p>Statistical engine first, AI second, you last — as it should be.</p>
        </div>
      </footer>
    </div>
  );
}

export function RankChange({ delta }: { delta: number | undefined }): ReactNode {
  if (delta == null || delta === 0) {
    return <span className="rank-change rc-flat">—</span>;
  }
  return delta > 0 ? (
    <span className="rank-change rc-up">▲ +{delta}</span>
  ) : (
    <span className="rank-change rc-down">▼ {delta}</span>
  );
}

export function Loading(): ReactNode {
  return (
    <div className="container" style={{ padding: '60px 24px', textAlign: 'center' }}>
      <span className="spinner" />
    </div>
  );
}
