import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, n } from '../api';
import { Loading } from '../components/Layout';

type Tab = 'users' | 'providers' | 'ai' | 'weights' | 'logs' | 'queue';

export function AdminPage(): ReactNode {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <div className="container">
      <section className="section">
        <p className="kicker">Admin · The Back Office</p>
        <div className="section-head"><h2 className="section-title">Administration</h2></div>
        <div className="tab-row" data-testid="admin-tabs">
          {(['users', 'providers', 'ai', 'weights', 'logs', 'queue'] as Tab[]).map((t) => (
            <button key={t} className={`chip-paper ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)} data-testid={`admin-tab-${t}`}>
              {{ users: 'Users & tokens', providers: 'API switch (max 2)', ai: 'AI switch (max 1)', weights: 'Model weights', logs: 'Logs & costs', queue: 'Review queue' }[t]}
            </button>
          ))}
        </div>
        {tab === 'users' && <UsersTab />}
        {tab === 'providers' && <ProvidersTab />}
        {tab === 'ai' && <AiTab />}
        {tab === 'weights' && <WeightsTab />}
        {tab === 'logs' && <LogsTab />}
        {tab === 'queue' && <QueueTab />}
      </section>
    </div>
  );
}

interface AdminUser { id: number; email: string; name: string; role: string; status: string; token_balance: number; usage: { credits: number; calls: number } }

function UsersTab(): ReactNode {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'user', initialTokens: 1000 });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = (): void => {
    void api.get<{ users: AdminUser[] }>('/api/admin/users').then((r) => setUsers(r.users));
  };
  useEffect(load, []);

  const create = async (): Promise<void> => {
    setErr('');
    setMsg('');
    try {
      await api.post('/api/admin/users', form);
      setMsg(`created ${form.email}`);
      setForm({ email: '', name: '', password: '', role: 'user', initialTokens: 1000 });
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const topup = async (id: number): Promise<void> => {
    const amount = prompt('Top-up amount (credits):', '1000');
    if (!amount) return;
    try {
      await api.post(`/api/admin/users/${id}/topup`, { amount: Number(amount), note: 'admin top-up' });
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const toggleStatus = async (u: AdminUser): Promise<void> => {
    await api.patch(`/api/admin/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' });
    load();
  };

  const resetPassword = async (u: AdminUser): Promise<void> => {
    const pw = prompt(`New password for ${u.email} (min 10 chars):`);
    if (!pw) return;
    try {
      await api.patch(`/api/admin/users/${u.id}`, { password: pw });
      setMsg(`password reset for ${u.email}; their sessions were revoked`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!users) return <Loading />;
  return (
    <div className="stack">
      <div className="card-shade">
        <p className="kicker">Create user (no self-registration)</p>
        <div className="row">
          <input className="input-paper" style={{ width: 210 }} placeholder="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="admin-new-email" />
          <input className="input-paper" style={{ width: 160 }} placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="admin-new-name" />
          <input className="input-paper" style={{ width: 180 }} placeholder="password (10+)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="admin-new-password" />
          <select className="input-paper" style={{ width: 110 }} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <input className="input-paper" style={{ width: 120 }} type="number" value={form.initialTokens} onChange={(e) => setForm({ ...form, initialTokens: Number(e.target.value) })} title="initial tokens" />
          <button className="btn-glass" onClick={() => void create()} data-testid="admin-create-user">Create</button>
        </div>
        {msg && <div className="ok-note">{msg}</div>}
        {err && <div className="err-note" data-testid="admin-user-error">{err}</div>}
      </div>
      <div className="table-wrap">
        <table data-testid="admin-users-table">
          <thead><tr><th>ID</th><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Balance</th><th>Usage (credits)</th><th>Actions</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.id}</td>
                <td>{u.email}</td>
                <td>{u.name}</td>
                <td><span className={`badge ${u.role === 'admin' ? 'brass' : ''}`}>{u.role}</span></td>
                <td><span className={`badge ${u.status === 'active' ? 'ok' : 'bad'}`}>{u.status}</span></td>
                <td className="mono" data-testid={`balance-${u.email}`}>{u.role === 'admin' ? '∞' : u.token_balance.toLocaleString()}</td>
                <td className="mono">{u.usage.credits.toLocaleString()} / {u.usage.calls} calls</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="chip-paper" onClick={() => void topup(u.id)} data-testid={`topup-${u.email}`}>top up</button>
                    <button className="chip-paper" onClick={() => void resetPassword(u)}>reset pw</button>
                    <button className="chip-paper" onClick={() => void toggleStatus(u)}>{u.status === 'active' ? 'disable' : 'enable'}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ApiProvider { key: string; name: string; enabled: boolean; state: string; keyConfigured: boolean; config: { anchor?: boolean }; quota_used: number; quota_limit: number | null }

function ProvidersTab(): ReactNode {
  const [data, setData] = useState<{ providers: ApiProvider[]; pairings: { name: string; pair: string[]; note: string }[] } | null>(null);
  const [err, setErr] = useState('');

  const load = (): void => {
    void api.get<typeof data>('/api/admin/providers').then(setData);
  };
  useEffect(load, []);

  const toggle = async (p: ApiProvider): Promise<void> => {
    setErr('');
    try {
      await api.post(`/api/admin/providers/${p.key}/toggle`, { enabled: !p.enabled });
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!data) return <Loading />;
  const enabledCount = data.providers.filter((p) => p.enabled && !p.config?.anchor).length;
  return (
    <div className="stack">
      {err && <div className="err-note" data-testid="provider-error">{err}</div>}
      <div className="warn-note">At most <b>2</b> providers may be enabled ({enabledCount}/2 in use). The FPL official API is the always-on anchor and doesn't count. Enforced server-side.</div>
      <div className="cards-grid">
        {data.providers.map((p) => (
          <div className="card" key={p.key} data-testid={`provider-${p.key}`}>
            <div className="spread">
              <h3 className="serif" style={{ fontSize: '1.05rem' }}>{p.name}</h3>
              <span className={`badge ${p.state === 'ok' ? 'ok' : 'bad'}`}>{p.state}</span>
            </div>
            <p className="mono muted" style={{ fontSize: '.74rem', margin: '8px 0' }}>
              key: {p.keyConfigured ? '✓ configured' : '✗ missing'} · quota {p.quota_used}{p.quota_limit ? `/${p.quota_limit}` : ''}
            </p>
            {p.config?.anchor ? (
              <span className="badge brass">anchor — always on</span>
            ) : (
              <button className={`chip-paper ${p.enabled ? 'active' : ''}`} onClick={() => void toggle(p)} data-testid={`provider-toggle-${p.key}`}>
                {p.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="card-shade">
        <p className="kicker">Pairing guidance</p>
        {data.pairings.map((pr) => (
          <p key={pr.name} style={{ fontSize: '.88rem', marginBottom: 8 }}>
            <b className="serif">{pr.name}</b> — <span className="mono" style={{ fontSize: '.76rem' }}>{pr.pair.join(' + ')}</span>: <span className="muted">{pr.note}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

interface AiProvider { key: string; name: string; alive: boolean; supports_vision: boolean; keyConfigured: boolean }

function AiTab(): ReactNode {
  const [providers, setProviders] = useState<AiProvider[] | null>(null);
  const [err, setErr] = useState('');

  const load = (): void => {
    void api.get<{ providers: AiProvider[] }>('/api/admin/ai-providers').then((r) => setProviders(r.providers));
  };
  useEffect(load, []);

  const activate = async (key: string): Promise<void> => {
    setErr('');
    try {
      await api.post(`/api/admin/ai-providers/${key}/activate`);
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!providers) return <Loading />;
  return (
    <div className="stack">
      {err && <div className="err-note" data-testid="ai-error">{err}</div>}
      <div className="warn-note">Exactly <b>one</b> AI provider may be alive. Activating one atomically deactivates the incumbent. A health probe runs at activation — unreachable providers stay un-enableable. <b>The AI never runs on a schedule — only when a human presses Run.</b></div>
      <div className="cards-grid">
        {providers.map((p) => (
          <div className="card" key={p.key} data-testid={`ai-${p.key}`}>
            <div className="spread">
              <h3 className="serif" style={{ fontSize: '1.05rem' }}>{p.name}</h3>
              {p.alive && <span className="badge ok">ALIVE</span>}
            </div>
            <p className="mono muted" style={{ fontSize: '.74rem', margin: '8px 0' }}>
              key: {p.keyConfigured ? '✓' : '✗'} · vision: {p.supports_vision ? 'yes' : 'no'}
            </p>
            {!p.alive && (
              <button className="chip-paper" onClick={() => void activate(p.key)} data-testid={`ai-activate-${p.key}`}>Activate</button>
            )}
          </div>
        ))}
      </div>
      <button className="chip-paper" onClick={() => void api.post('/api/admin/ai-providers/deactivate').then(load)}>Deactivate all (disable the AI layer)</button>
    </div>
  );
}

function WeightsTab(): ReactNode {
  const [weights, setWeights] = useState<Record<string, number> | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void api.get<{ value: Record<string, number> }>('/api/admin/config/stat_score_weights').then((r) => setWeights(r.value));
  }, []);

  const save = async (): Promise<void> => {
    if (!weights) return;
    const r = await api.put<{ version: number }>('/api/admin/config/stat_score_weights', { value: weights });
    setMsg(`saved as config version ${r.version} — the next run will use it`);
  };

  if (!weights) return <Loading />;
  const labels: Record<string, string> = {
    w1: 'w1 · xPts next 3 (z)',
    w2: 'w2 · xPts next 1 (z)',
    w3: 'w3 · form EWMA (z)',
    w4: 'w4 · start probability',
    w5: 'w5 · value xPts/price (z)',
    w6: 'w6 · fixture outlook',
  };
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <p className="kicker">stat_score weights (versioned — every run records the version it used)</p>
      <div className="stack">
        {Object.keys(labels).map((k) => (
          <label className="spread" key={k}>
            <span style={{ fontSize: '.9rem' }}>{labels[k]}</span>
            <input className="input-paper" style={{ width: 110 }} type="number" step="0.01" value={weights[k] ?? 0}
              onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} data-testid={`weight-${k}`} />
          </label>
        ))}
        <button className="btn-glass" onClick={() => void save()} data-testid="weights-save">Save as new version</button>
        {msg && <div className="ok-note">{msg}</div>}
      </div>
    </div>
  );
}

function LogsTab(): ReactNode {
  const [pulls, setPulls] = useState<{ log: { id: number; provider: string; capability: string; endpoint: string; records: number; latency_ms: number; status: string; error_class: string | null; created_at: string }[]; quarantined: number } | null>(null);
  const [ai, setAi] = useState<{ calls: { id: number; provider: string; kind: string; user_email: string; batch_size: number; prompt_tokens: string; completion_tokens: string; cached_tokens: string; credits: string; status: string; created_at: string }[]; daily: { day: string; credits: string; prompt: string; completion: string; cached: string }[] } | null>(null);

  useEffect(() => {
    void api.get<typeof pulls>('/api/admin/pull-log').then(setPulls);
    void api.get<typeof ai>('/api/admin/ai-calls').then(setAi);
  }, []);

  if (!pulls || !ai) return <Loading />;
  const maxCredits = Math.max(1, ...ai.daily.map((d) => Number(d.credits)));
  return (
    <div className="stack">
      <div className="card">
        <p className="kicker">Daily AI cost (credits, last 30 days)</p>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 90 }}>
          {ai.daily.slice().reverse().map((d) => (
            <div key={d.day} title={`${d.day.slice(0, 10)}: ${d.credits} credits`} style={{ flex: 1, minWidth: 4, height: `${(Number(d.credits) / maxCredits) * 100}%`, background: 'var(--navy)', borderRadius: 2 }} />
          ))}
          {ai.daily.length === 0 && <p className="muted">No AI calls yet.</p>}
        </div>
      </div>
      <div>
        <p className="kicker">AI calls (latest 100)</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Provider</th><th>Kind</th><th>User</th><th>Batch</th><th>Prompt</th><th>Compl.</th><th>Cached</th><th>Credits</th><th>Status</th></tr></thead>
            <tbody>
              {ai.calls.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td><td>{c.provider}</td><td>{c.kind}</td><td>{c.user_email}</td>
                  <td className="mono">{c.batch_size}</td><td className="mono">{Number(c.prompt_tokens).toLocaleString()}</td>
                  <td className="mono">{Number(c.completion_tokens).toLocaleString()}</td><td className="mono">{Number(c.cached_tokens).toLocaleString()}</td>
                  <td className="mono">{c.credits}</td>
                  <td><span className={`badge ${c.status === 'ok' ? 'ok' : 'bad'}`}>{c.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <p className="kicker">API pull log (latest 100 · {pulls.quarantined} quarantined rows)</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Provider</th><th>Capability</th><th>Endpoint</th><th>Records</th><th>Latency</th><th>Status</th><th>Error</th><th>At</th></tr></thead>
            <tbody>
              {pulls.log.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.id}</td><td>{l.provider}</td><td>{l.capability}</td><td className="mono" style={{ fontSize: '.76rem' }}>{l.endpoint}</td>
                  <td className="mono">{l.records}</td><td className="mono">{l.latency_ms}ms</td>
                  <td><span className={`badge ${l.status === 'ok' ? 'ok' : l.status === 'empty_ok' ? '' : 'bad'}`}>{l.status}</span></td>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{l.error_class ?? '—'}</td>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(l.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function QueueTab(): ReactNode {
  const [queue, setQueue] = useState<{ id: number; provider: string; provider_id: string; status: string; payload: { name?: string }; candidates: { uid: string; name: string; team_uid: string; similarity: number }[] }[] | null>(null);

  const load = (): void => {
    void api.get<{ queue: typeof queue }>('/api/admin/resolution-queue').then((r) => setQueue(r.queue));
  };
  useEffect(load, []);

  const resolve = async (id: number, playerUid: string | null): Promise<void> => {
    await api.post(`/api/admin/resolution-queue/${id}/resolve`, { playerUid });
    load();
  };

  if (!queue) return <Loading />;
  return (
    <div className="stack">
      <p className="muted" style={{ fontSize: '.88rem' }}>
        Provider records the resolver could not deterministically match. Nothing auto-merges below the deterministic tier — your call is final and teaches the alias table.
      </p>
      {queue.length === 0 && <div className="ok-note">Queue is empty — the resolver is keeping up.</div>}
      {queue.map((q) => (
        <div className="card" key={q.id}>
          <div className="spread">
            <span><b className="serif">{q.payload?.name ?? '(unnamed)'}</b> <span className="mono muted" style={{ fontSize: '.74rem' }}>{q.provider} #{q.provider_id} · {q.status}</span></span>
            <button className="chip-paper" style={{ color: 'var(--brick)' }} onClick={() => void resolve(q.id, null)}>Ignore permanently</button>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {q.candidates.map((c) => (
              <button key={c.uid} className="chip-paper" onClick={() => void resolve(q.id, c.uid)}>
                {c.name} ({Math.round(c.similarity * 100)}%)
              </button>
            ))}
            {q.candidates.length === 0 && <span className="muted">no candidates — likely a player FPL doesn't have</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
