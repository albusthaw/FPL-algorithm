import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, n } from '../api';
import { Loading } from '../components/Layout';

type Tab = 'users' | 'providers' | 'ai' | 'weights' | 'logs' | 'queue' | 'coverage' | 'backtest';

export function AdminPage(): ReactNode {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <div className="container">
      <section className="section">
        <p className="kicker">Admin · The Back Office</p>
        <div className="section-head"><h2 className="section-title">Administration</h2></div>
        <div className="tab-row" data-testid="admin-tabs">
          {(['users', 'providers', 'ai', 'weights', 'logs', 'queue', 'coverage', 'backtest'] as Tab[]).map((t) => (
            <button key={t} className={`chip-paper ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)} data-testid={`admin-tab-${t}`}>
              {{ users: 'Users & tokens', providers: 'Data providers (max 2)', ai: 'AI provider (max 1)', weights: 'Ranking weights', logs: 'Logs & costs', queue: 'Review queue', coverage: 'Data coverage', backtest: 'Backtest' }[t]}
            </button>
          ))}
        </div>
        {tab === 'users' && <UsersTab />}
        {tab === 'providers' && <ProvidersTab />}
        {tab === 'ai' && <AiTab />}
        {tab === 'weights' && <WeightsTab />}
        {tab === 'logs' && <LogsTab />}
        {tab === 'queue' && <QueueTab />}
        {tab === 'coverage' && <CoverageTab />}
        {tab === 'backtest' && <BacktestTab />}
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

interface KeyField { env: string; label: string; secret: boolean; set: boolean }
interface PlanTier { id: string; label: string; cost: string; note: string }
interface ApiProvider { key: string; name: string; enabled: boolean; state: string; keyConfigured: boolean; keyHint: string | null; requiresKey: boolean; keyFields: KeyField[]; config: { anchor?: boolean }; quota_used: number; quota_limit: number | null; plan?: string; planTiers?: PlanTier[] }

/** Enter/replace a provider's API key. The value is write-only: sent once,
 *  stored server-side, never shown again — only “set (…last4)”. */
function KeyEntry({ fields, hint, onSaved }: { fields: KeyField[]; hint: string | null; onSaved: () => void }): ReactNode {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  if (fields.length === 0) return null;

  const save = async (f: KeyField): Promise<void> => {
    const value = (values[f.env] ?? '').trim();
    if (!value) return;
    setBusy(true);
    setErr('');
    setSaved('');
    try {
      await api.put('/api/admin/keys', { env: f.env, value });
      setValues((v) => ({ ...v, [f.env]: '' }));
      setSaved('saved — active immediately');
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 6, marginTop: 8 }}>
      {fields.map((f) => (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} key={f.env}>
          <input
            className="input-paper"
            style={{ width: 210, fontSize: '.8rem' }}
            type={f.secret ? 'password' : 'text'}
            placeholder={f.set ? `${f.label} — set${hint ? ` (${hint})` : ''}, paste to replace` : f.label}
            value={values[f.env] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.env]: e.target.value }))}
            autoComplete="off"
            data-testid={`key-input-${f.env}`}
          />
          <button className="chip-paper" disabled={busy || !(values[f.env] ?? '').trim()} onClick={() => void save(f)} data-testid={`key-save-${f.env}`}>
            Save
          </button>
        </div>
      ))}
      {saved && <span className="mono" style={{ fontSize: '.72rem', color: 'var(--green-up)' }}>{saved}</span>}
      {err && <span className="mono" style={{ fontSize: '.72rem', color: 'var(--brick)' }}>{err}</span>}
    </div>
  );
}

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
              key: {p.keyConfigured ? `✓ set${p.keyHint ? ` (${p.keyHint})` : ''}` : p.requiresKey ? '✗ required to enable' : 'not needed'}
              {' · '}quota {p.quota_used}{p.quota_limit ? `/${p.quota_limit}` : ''}
            </p>
            {/* P1 (v1.4.2): subscription plan selector — fills quota_limit and
                re-arms entitlement probes; depth options follow the plan */}
            {(p.planTiers?.length ?? 0) > 0 && (
              <label className="row" style={{ gap: 8, margin: '6px 0 10px' }}>
                <span className="mono muted" style={{ fontSize: '.68rem' }}>PLAN</span>
                <select
                  className="input-paper"
                  style={{ minWidth: 170, fontSize: '.8rem' }}
                  value={p.plan ?? 'free'}
                  data-testid={`provider-plan-${p.key}`}
                  onChange={(e) => {
                    void api
                      .put(`/api/admin/providers/${p.key}/plan`, { plan: e.target.value })
                      .then(load)
                      .catch((err2) => setErr(err2 instanceof ApiError ? err2.message : String(err2)));
                  }}
                >
                  {(p.planTiers ?? []).map((t) => (
                    <option key={t.id} value={t.id} title={t.note}>{t.label} · {t.cost}</option>
                  ))}
                </select>
              </label>
            )}
            {p.config?.anchor ? (
              <span className="badge brass">always on</span>
            ) : (
              <>
                <button
                  className={`chip-paper ${p.enabled ? 'active' : ''}`}
                  onClick={() => void toggle(p)}
                  disabled={!p.enabled && p.requiresKey && !p.keyConfigured}
                  title={!p.enabled && p.requiresKey && !p.keyConfigured ? 'Add the API key below first' : undefined}
                  data-testid={`provider-toggle-${p.key}`}
                >
                  {p.enabled ? 'Enabled — click to disable' : p.requiresKey && !p.keyConfigured ? 'Add API key to enable' : 'Disabled — click to enable'}
                </button>
                <KeyEntry fields={p.keyFields ?? []} hint={p.keyHint} onSaved={load} />
              </>
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

interface AiCapabilities { tokenParam: string; temperature: string; vision: boolean; json: string; learned: Record<string, unknown> | null }
interface AiProvider { key: string; name: string; alive: boolean; supports_vision: boolean; keyConfigured: boolean; keyHint: string | null; requiresKey: boolean; keyFields: KeyField[]; model: string | null; capabilities?: AiCapabilities }

/** Model choice per AI provider: type one, or load the provider's live list. */
function ModelPicker({ provider, onSaved }: { provider: AiProvider; onSaved: () => void }): ReactNode {
  const [models, setModels] = useState<string[] | null>(null);
  const [choice, setChoice] = useState(provider.model ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const loadModels = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.get<{ models: string[]; current: string | null }>(`/api/admin/ai-providers/${provider.key}/models`);
      setModels(r.models);
      if (!choice && r.current) setChoice(r.current);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!choice.trim()) return;
    setBusy(true);
    setErr('');
    setOk('');
    try {
      await api.put(`/api/admin/ai-providers/${provider.key}/model`, { model: choice.trim() });
      setOk('model saved');
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 6, marginTop: 8 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {models ? (
          <select className="input-paper" style={{ width: 210, fontSize: '.8rem' }} value={choice} onChange={(e) => setChoice(e.target.value)} data-testid={`model-select-${provider.key}`}>
            <option value="">— choose a model —</option>
            {models.map((m) => (<option key={m} value={m}>{m}</option>))}
          </select>
        ) : (
          <input
            className="input-paper"
            style={{ width: 210, fontSize: '.8rem' }}
            placeholder={provider.model ? `model: ${provider.model}` : 'model (or load the list →)'}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            data-testid={`model-input-${provider.key}`}
          />
        )}
        <button className="chip-paper" disabled={busy} onClick={() => void loadModels()} data-testid={`model-load-${provider.key}`} title="Fetch the provider's live model list">
          {busy ? '…' : 'Load models'}
        </button>
        <button className="chip-paper" disabled={busy || !choice.trim()} onClick={() => void save()} data-testid={`model-save-${provider.key}`}>
          Save
        </button>
      </div>
      {ok && <span className="mono" style={{ fontSize: '.72rem', color: 'var(--green-up)' }}>{ok}</span>}
      {err && <span className="mono" style={{ fontSize: '.72rem', color: 'var(--brick)' }}>{err}</span>}
    </div>
  );
}

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
      <div className="warn-note">Exactly <b>one</b> AI provider may be active at a time; activating one switches the previous one off. Activation checks the provider is reachable with your key first. <b>The AI never runs on a schedule — only when you press Run.</b></div>
      <div className="cards-grid">
        {providers.map((p) => (
          <div className="card" key={p.key} data-testid={`ai-${p.key}`}>
            <div className="spread">
              <h3 className="serif" style={{ fontSize: '1.05rem' }}>{p.name}</h3>
              {p.alive && <span className="badge ok">ACTIVE</span>}
            </div>
            <p className="mono muted" style={{ fontSize: '.74rem', margin: '8px 0' }}>
              key: {p.keyConfigured ? `✓ set${p.keyHint ? ` (${p.keyHint})` : ''}` : p.requiresKey ? '✗ required' : 'not needed'}
              {p.model ? <> · model: <b>{p.model}</b></> : ''}
            </p>
            {p.capabilities && (
              <p className="mono muted" style={{ fontSize: '.7rem', margin: '0 0 8px' }} data-testid={`ai-caps-${p.key}`}>
                model capabilities: {p.capabilities.vision ? 'vision-capable ✓' : 'no vision'}
                {' · '}<span title="the token-limit parameter this model accepts">{p.capabilities.tokenParam}</span>
                {' · '}{p.capabilities.temperature === 'omit' ? <b style={{ color: 'var(--brick)' }}>temperature locked</b> : 'temperature free'}
                {p.capabilities.learned ? ' · learned from live probe' : ''}
              </p>
            )}
            {!p.alive && (
              <button
                className="chip-paper"
                onClick={() => void activate(p.key)}
                disabled={p.requiresKey && !p.keyConfigured}
                title={p.requiresKey && !p.keyConfigured ? 'Add the API key below first' : undefined}
                data-testid={`ai-activate-${p.key}`}
              >
                {p.requiresKey && !p.keyConfigured ? 'Add API key to activate' : 'Activate'}
              </button>
            )}
            <KeyEntry fields={p.keyFields ?? []} hint={p.keyHint} onSaved={load} />
            <ModelPicker provider={p} onSaved={load} />
          </div>
        ))}
      </div>
      <button className="chip-paper" onClick={() => void api.post('/api/admin/ai-providers/deactivate').then(load)}>Switch AI off (statistical runs only)</button>
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
      <p className="kicker">Ranking weights (versioned — every update records the version it used)</p>
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

interface CoverageRow {
  uid: string; web_name: string; position: string; club: string | null; status: string;
  history_matches: number; history_minutes: number; xg_rows: number; news_7d: number;
  identities: number; set_piece: boolean; in_latest_run: boolean;
}

interface HistoryData {
  depth: { mode: 'days' | 'seasons'; days: number; seasons: number; career_aggregates: boolean; max_seasons: number };
  coverage: { provider: string; granularity: string; allowed: string; configured: string; imported: string }[];
  ledger: { id: number; provider: string; scope: string; status: string; records: number; detail: string | null; finished_at: string | null }[];
}

function HistoryDepthPanel(): ReactNode {
  const [data, setData] = useState<HistoryData | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

  const load = (): void => {
    void api.get<HistoryData>('/api/admin/history').then(setData);
  };
  useEffect(load, []);

  if (!data) return <Loading />;
  const d = data.depth;

  const save = async (next: HistoryData['depth']): Promise<void> => {
    setSaving(true);
    try {
      await api.put('/api/admin/config/history_depth', { value: next });
      setNote('saved — the next Run (or Backfill now) pulls to this depth');
      load();
    } finally {
      setSaving(false);
    }
  };

  const backfill = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.post('/api/admin/backfill', {});
      setNote('backfill started — progress appears in the ledger below');
      setTimeout(load, 2500);
    } catch (err) {
      setNote(String((err as Error).message ?? err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack" data-testid="history-depth">
      <div className="kicker">Past-data depth</div>
      <div className="stat-panel">
        <h4>How far back each source can go</h4>
        <div className="table-wrap">
          <table data-testid="history-coverage-table">
            <thead><tr><th>Source</th><th>Granularity</th><th>Available depth</th><th>Configured</th><th>Imported</th></tr></thead>
            <tbody>
              {data.coverage.map((c) => (
                <tr key={c.provider}>
                  <td className="mono">{c.provider}</td>
                  <td>{c.granularity}</td>
                  <td>{c.allowed}</td>
                  <td>{c.configured}</td>
                  <td>{c.imported}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="chip-paper">
          depth&nbsp;
          <select
            value={d.mode === 'days' ? 'days' : String(Math.min(d.seasons, d.max_seasons))}
            disabled={saving}
            onChange={(e) => {
              const v = e.target.value;
              void save(v === 'days' ? { ...d, mode: 'days' } : { ...d, mode: 'seasons', seasons: Number(v) });
            }}
            data-testid="history-depth-select"
          >
            <option value="days">last {d.days} days (default)</option>
            <option value="1">last season (per-GW)</option>
            <option value="2">last 2 seasons</option>
            <option value="5">last 5 seasons</option>
            <option value="10">last 10 seasons (max per-GW)</option>
          </select>
        </label>
        <label className="chip-paper" style={{ cursor: 'pointer', whiteSpace: 'normal', maxWidth: '100%' }}>
          <input
            type="checkbox"
            checked={d.career_aggregates}
            disabled={saving}
            onChange={(e) => void save({ ...d, career_aggregates: e.target.checked })}
            style={{ marginRight: 8, accentColor: 'var(--brick)' }}
          />
          career season totals (up to ~20 years)
        </label>
        <button className="btn-glass" onClick={() => void backfill()} disabled={saving} data-testid="backfill-now">
          Backfill now
        </button>
        {note && <span className="muted">{note}</span>}
      </div>
      {data.ledger.length > 0 && (
        <div className="table-wrap">
          <table data-testid="history-ledger-table">
            <thead><tr><th>Source</th><th>Scope</th><th>Status</th><th>Rows</th><th>Detail</th></tr></thead>
            <tbody>
              {data.ledger.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.provider}</td>
                  <td className="mono">{l.scope}</td>
                  <td>{l.status === 'complete' ? <span className="badge ok">complete</span> : l.status === 'failed' ? <span className="badge bad">failed</span> : <span className="muted">{l.status}</span>}</td>
                  <td className="mono">{l.records.toLocaleString()}</td>
                  <td className="muted">{l.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CoverageTab(): ReactNode {
  const [data, setData] = useState<{ summary: { runId: number | null; totalActive: number; inLatestRun: number; withHistory: number; withNews7d: number; withSetPiece: number; zeroHistory: number }; players: CoverageRow[] } | null>(null);
  const [gapsOnly, setGapsOnly] = useState(false);

  useEffect(() => {
    void api.get<typeof data>('/api/admin/data-coverage').then(setData);
  }, []);

  if (!data) return <Loading />;
  const { summary } = data;
  const shown = gapsOnly
    ? data.players.filter((p) => !p.in_latest_run || p.history_matches === 0)
    : data.players;
  return (
    <div className="stack">
      <div className="stat-panel">
        <h4>Coverage at a glance</h4>
        <div className="stat-row"><span>Active players</span><b>{summary.totalActive}</b></div>
        <div className="stat-row"><span>Scored in the latest rankings</span><b data-testid="coverage-in-run">{summary.inLatestRun} / {summary.totalActive}</b></div>
        <div className="stat-row"><span>With match history</span><b>{summary.withHistory}</b></div>
        <div className="stat-row"><span>With news this week</span><b>{summary.withNews7d}</b></div>
        <div className="stat-row"><span>With set-piece duty data</span><b>{summary.withSetPiece}</b></div>
        <div className="stat-row"><span>No history yet (season-start estimates)</span><b>{summary.zeroHistory}</b></div>
      </div>
      <HistoryDepthPanel />
      <label className="chip-paper" style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>
        <input type="checkbox" checked={gapsOnly} onChange={(e) => setGapsOnly(e.target.checked)} style={{ marginRight: 8, accentColor: 'var(--brick)' }} />
        show gaps only
      </label>
      <div className="table-wrap">
        <table data-testid="coverage-table">
          <thead><tr><th>Player</th><th>Pos</th><th>Club</th><th>Matches</th><th>Minutes</th><th>xG rows</th><th>News 7d</th><th>Sources</th><th>Set piece</th><th>In rankings</th></tr></thead>
          <tbody>
            {shown.slice(0, 400).map((p) => (
              <tr key={p.uid}>
                <td className="team-name">{p.web_name}</td>
                <td className="mono">{p.position}</td>
                <td className="mono">{p.club ?? '—'}</td>
                <td className="mono">{p.history_matches}</td>
                <td className="mono">{p.history_minutes.toLocaleString()}</td>
                <td className="mono">{p.xg_rows}</td>
                <td className="mono">{p.news_7d}</td>
                <td className="mono">{p.identities}</td>
                <td>{p.set_piece ? <span className="badge ok">yes</span> : <span className="muted">—</span>}</td>
                <td>{p.in_latest_run ? <span className="badge ok">yes</span> : <span className="badge bad">missing</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── A4 (v1.4.5): the backtest & calibration harness ──────────────────────
interface BacktestRun { id: number; status: string; stages: { seasons?: string[]; events?: number; samples?: number; maeXpts?: number; rmseXpts?: number; minutesMae?: number; fixtureBrier?: number; fixtures?: number; maeByPosition?: Record<string, number> } | null; started_at: string; finished_at: string | null }
interface CalibrationRow { bucket: number; pred: number; actual: number; n: number }

function BacktestTab(): ReactNode {
  const [data, setData] = useState<{ running: boolean; runs: BacktestRun[]; calibration: CalibrationRow[] | null } | null>(null);
  const [msg, setMsg] = useState('');

  const load = (): void => {
    void api.get<typeof data>('/api/admin/backtest').then(setData).catch(() => setData(null));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (path: string, label: string): Promise<void> => {
    setMsg('');
    try {
      await api.post(path, {});
      setMsg(`${label} started — walk-forward over the imported seasons (watch this tab).`);
      load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!data) return <Loading />;
  const latest = data.runs[0];

  return (
    <div className="stack" data-testid="backtest-tab">
      <div className="card-shade">
        <p className="kicker">Walk-forward backtest (audit A4)</p>
        <p style={{ fontSize: '.88rem', marginBottom: 12 }}>
          Replays imported seasons through the live engine's own functions, strictly as-of each historical
          deadline. Errors land in <span className="mono">model_errors</span>; the refit grid-searches the decay
          and shrinkage constants and writes improvements as <b>new config versions</b> — never code edits.
        </p>
        <div className="row">
          <button className="btn-glass" disabled={data.running} onClick={() => void start('/api/admin/backtest', 'Backtest')} data-testid="backtest-start">
            {data.running ? 'Running…' : 'Run backtest'}
          </button>
          <button className="btn-glass" disabled={data.running} onClick={() => void start('/api/admin/refit', 'Constant refit')} data-testid="refit-start">
            Refit constants
          </button>
        </div>
        {msg && <p className="mono muted" style={{ fontSize: '.76rem', marginTop: 8 }}>{msg}</p>}
      </div>

      {latest?.stages && (
        <div className="stat-panel" data-testid="backtest-metrics">
          <h4>Latest backtest — run #{latest.id}</h4>
          <div className="stat-row"><span>Seasons</span><b>{(latest.stages.seasons ?? []).join(', ') || '—'}</b></div>
          <div className="stat-row"><span>Events × samples</span><b>{latest.stages.events ?? 0} × {latest.stages.samples?.toLocaleString() ?? 0}</b></div>
          <div className="stat-row"><span>xPts MAE / RMSE</span><b className="mono">{n(latest.stages.maeXpts ?? 0, 3)} / {n(latest.stages.rmseXpts ?? 0, 3)}</b></div>
          <div className="stat-row"><span>Minutes MAE</span><b className="mono">{n(latest.stages.minutesMae ?? 0)}</b></div>
          <div className="stat-row"><span>Fixture 1X2 Brier ({latest.stages.fixtures ?? 0} fixtures)</span><b className="mono">{n(latest.stages.fixtureBrier ?? 0, 3)} <span className="muted" style={{ fontSize: '.68rem' }}>(uniform = 0.667)</span></b></div>
          {Object.entries(latest.stages.maeByPosition ?? {}).map(([pos, mae]) => (
            <div className="stat-row" key={pos}><span>MAE · {pos}</span><b className="mono">{n(mae, 3)}</b></div>
          ))}
        </div>
      )}

      {data.calibration && data.calibration.length > 0 && (
        <div className="card">
          <p className="kicker">Calibration — predicted vs realised (per xPts bucket)</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Predicted (mean)</th><th>Realised (mean)</th><th>Samples</th><th>Bias</th></tr></thead>
              <tbody>
                {data.calibration.map((c) => (
                  <tr key={c.bucket}>
                    <td className="mono">{n(c.pred, 2)}</td>
                    <td className="mono">{n(c.actual, 2)}</td>
                    <td className="mono">{c.n.toLocaleString()}</td>
                    <td className={c.pred - c.actual > 0.5 ? 'rc-down' : c.actual - c.pred > 0.5 ? 'rc-up' : ''}>
                      {(c.pred - c.actual > 0 ? '+' : '') + n(c.pred - c.actual, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.runs.length > 1 && (
        <div className="card">
          <p className="kicker">Backtest history (non-regression record)</p>
          {data.runs.map((r) => (
            <p key={r.id} className="mono" style={{ fontSize: '.78rem', padding: '4px 0' }}>
              #{r.id} · {new Date(r.started_at).toLocaleString()} · MAE {n(r.stages?.maeXpts ?? 0, 3)} · Brier {n(r.stages?.fixtureBrier ?? 0, 3)} · {r.stages?.samples?.toLocaleString() ?? 0} samples
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
