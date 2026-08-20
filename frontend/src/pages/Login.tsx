import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';

export function LoginPage(): ReactNode {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const retry = (err.body as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        setError(`Too many attempts — locked for ${retry ?? '?'} s. Take a breath.`);
      } else {
        setError(err instanceof ApiError ? err.message : 'login failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <p className="kicker" style={{ color: '#CFA84E' }}>The Selection Desk</p>
          <h1>FPL ALGORITHM</h1>
          <p>Fantasy football, decided properly.</p>
        </div>
        <form onSubmit={(e) => void submit(e)} className="stack">
          <div className="glass-input-group">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              data-testid="login-email"
            />
          </div>
          <div className="glass-input-group">
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              data-testid="login-password"
            />
          </div>
          {error && <div className="err-note" data-testid="login-error">{error}</div>}
          <button className="btn-glass-dark" type="submit" disabled={busy} data-testid="login-submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p style={{ marginTop: 22, fontSize: '.78rem', color: '#8B96AC', textAlign: 'center' }}>
          No self-registration — accounts are created by your admin.
        </p>
      </div>
    </div>
  );
}
