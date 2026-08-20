import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, fmtPrice, n } from '../api';
import { Loading } from '../components/Layout';
import { PitchView, type PitchPlayer } from '../components/PitchView';

interface Card {
  uid: string;
  web_name: string;
  position: string;
  club: string;
  price: number;
  xpts_next1: string;
  xpts_next3: string;
  xpts_next6: string;
  overall_score: string;
  p_start_xi: string;
  ai_rationale: string;
  injury_status: string;
}

interface XiPayload {
  starters: string[];
  bench: string[];
  formation: number[];
  captain: string;
  vice: string;
  xpts: number;
}

function toPitch(squad: Card[], xi: XiPayload, horizon: 1 | 3 | 6): { starters: PitchPlayer[]; bench: PitchPlayer[] } {
  const byUid = new Map(squad.map((c) => [c.uid, c]));
  const mk = (uid: string): PitchPlayer | null => {
    const c = byUid.get(uid);
    if (!c) return null;
    return {
      uid,
      web_name: c.web_name,
      position: c.position,
      price: c.price,
      xpts: horizon === 1 ? c.xpts_next1 : horizon === 3 ? c.xpts_next3 : c.xpts_next6,
      isCaptain: uid === xi.captain,
      isVice: uid === xi.vice,
    };
  };
  return {
    starters: xi.starters.map(mk).filter((p): p is PitchPlayer => !!p),
    bench: xi.bench.map(mk).filter((p): p is PitchPlayer => !!p),
  };
}

function DiffView({ diff }: { diff: { out: Card[]; in: Card[]; deltaXpts?: number; deltaBudget?: number } }): ReactNode {
  return (
    <div className="matchup-feature" style={{ marginTop: 18 }}>
      <p className="kicker">Engine vs your team</p>
      <div className="matchup-compare">
        <div className="mc-team">
          <h4>Out</h4>
          {diff.out.map((c) => (
            <div key={c.uid} className="mono" style={{ fontSize: '.82rem' }}>− {c.web_name} ({c.position}, {fmtPrice(c.price)})</div>
          ))}
        </div>
        <div className="mc-vs">→</div>
        <div className="mc-team">
          <h4>In</h4>
          {diff.in.map((c) => (
            <div key={c.uid} className="mono" style={{ fontSize: '.82rem' }}>+ {c.web_name} ({c.position}, {fmtPrice(c.price)})</div>
          ))}
        </div>
      </div>
      {diff.deltaXpts != null && (
        <p className="mono" style={{ marginTop: 12, fontSize: '.82rem' }}>
          Δ xPts {diff.deltaXpts > 0 ? '+' : ''}{diff.deltaXpts} · Δ budget {((diff.deltaBudget ?? 0) / 10).toFixed(1)}m
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────── Mode 1: Initial XI ──
export function InitialModePage(): ReactNode {
  const [horizon, setHorizon] = useState<1 | 3 | 6>(6);
  const [budget, setBudget] = useState(1000);
  const [locked, setLocked] = useState<string[]>([]);
  const [banned, setBanned] = useState<string[]>([]);
  const [compareTeamId, setCompareTeamId] = useState<number | null>(null);
  const [teams, setTeams] = useState<{ id: number; name: string }[]>([]);
  const [result, setResult] = useState<{ squad: Card[]; xi: XiPayload; totalCost: number; method: string; diff: { out: Card[]; in: Card[]; deltaXpts: number; deltaBudget: number } | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerResults, setPickerResults] = useState<Card[]>([]);

  useEffect(() => {
    void api.get<{ teams: { id: number; name: string }[] }>('/api/teams').then((r) => setTeams(r.teams));
  }, []);

  useEffect(() => {
    if (pickerSearch.length < 2) {
      setPickerResults([]);
      return;
    }
    const t = setTimeout(() => {
      void api.get<{ players: Card[] }>(`/api/players?search=${encodeURIComponent(pickerSearch)}`).then((r) => setPickerResults(r.players.slice(0, 6)));
    }, 250);
    return () => clearTimeout(t);
  }, [pickerSearch]);

  const optimise = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setResult(await api.post('/api/modes/initial', { horizon, budget, locked, banned, compareTeamId }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container">
      <section className="section">
        <p className="kicker">Mode · Initial Team Selection</p>
        <div className="section-head"><h2 className="section-title">Build the optimal GW1 squad</h2></div>

        <div className="card-shade" style={{ marginBottom: 22 }}>
          <div className="row" style={{ gap: 18 }}>
            <div className="row">
              <span className="mono muted" style={{ fontSize: '.72rem' }}>HORIZON</span>
              {([1, 3, 6] as const).map((h) => (
                <button key={h} className={`chip-paper ${horizon === h ? 'active' : ''}`} onClick={() => setHorizon(h)}>next {h}</button>
              ))}
            </div>
            <label className="row" style={{ gap: 8 }}>
              <span className="mono muted" style={{ fontSize: '.72rem' }}>BUDGET £m</span>
              <input className="input-paper" style={{ width: 90 }} type="number" step="0.5" min="50" max="120" value={budget / 10}
                onChange={(e) => setBudget(Math.round(Number(e.target.value) * 10))} />
            </label>
            <label className="row" style={{ gap: 8 }}>
              <span className="mono muted" style={{ fontSize: '.72rem' }}>COMPARE VS</span>
              <select className="input-paper" style={{ width: 180 }} value={compareTeamId ?? ''} onChange={(e) => setCompareTeamId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— none —</option>
                {teams.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
              </select>
            </label>
            <button className="btn-glass" onClick={() => void optimise()} disabled={busy} data-testid="optimise-btn">
              {busy ? 'Optimising…' : 'Optimise squad'}
            </button>
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <input className="input-paper" style={{ width: 220 }} placeholder="Lock/ban a player…" value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} />
            {pickerResults.map((p) => (
              <span key={p.uid} className="row" style={{ gap: 4 }}>
                <span className="badge">{p.web_name}</span>
                <button className="chip-paper" onClick={() => { setLocked((l) => [...new Set([...l, p.uid])]); setPickerSearch(''); }}>lock</button>
                <button className="chip-paper" onClick={() => { setBanned((b) => [...new Set([...b, p.uid])]); setPickerSearch(''); }}>ban</button>
              </span>
            ))}
          </div>
          {(locked.length > 0 || banned.length > 0) && (
            <div className="row" style={{ marginTop: 10 }}>
              {locked.map((uid) => (
                <button key={uid} className="badge ok" onClick={() => setLocked((l) => l.filter((x) => x !== uid))}>🔒 {result?.squad.find((c) => c.uid === uid)?.web_name ?? uid.slice(0, 10)} ✕</button>
              ))}
              {banned.map((uid) => (
                <button key={uid} className="badge bad" onClick={() => setBanned((b) => b.filter((x) => x !== uid))}>🚫 {uid.slice(0, 10)} ✕</button>
              ))}
            </div>
          )}
        </div>

        {error && <div className="err-note">{error}</div>}
        {result && (
          <div className="grid-2" style={{ alignItems: 'start' }}>
            <div>
              <PitchView {...toPitch(result.squad, result.xi, horizon)} />
              {result.diff && <DiffView diff={result.diff} />}
            </div>
            <div className="stat-panel">
              <h4>Squad summary</h4>
              <div className="stat-row"><span>Formation</span><b>{result.xi.formation.slice(1).join('-')}</b></div>
              <div className="stat-row"><span>XI xPts (captain doubled)</span><b>{result.xi.xpts}</b></div>
              <div className="stat-row"><span>Total cost</span><b>{fmtPrice(result.totalCost)}</b></div>
              <div className="stat-row"><span>In the bank</span><b>{fmtPrice(budget - result.totalCost)}</b></div>
              <div className="stat-row"><span>Solver</span><b>{result.method.toUpperCase()}</b></div>
              <div className="stat-row"><span>Captain</span><b>{result.squad.find((c) => c.uid === result.xi.captain)?.web_name ?? '—'}</b></div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────── Mode 2: Free Hit / Wildcard ──
interface ChipRec { chip: string; chip_set: number; event: number; value: string; urgency: number; caveats: string[] }

const CHIP_LABEL: Record<string, string> = { freehit: 'Free Hit', wildcard: 'Wildcard', bboost: 'Bench Boost', '3xc': 'Triple Captain' };

export function ChipsModePage(): ReactNode {
  const [teams, setTeams] = useState<{ id: number; name: string; playerCount: number }[]>([]);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [data, setData] = useState<{ recommendations: ChipRec[]; coverage: { coverage_score: string; gaps: { event: number; kind: string; leverage: number }[] } | null; gwFixtureCounts: { event: number; fixtures: number }[]; chipSquad: { chip: string; event: number; squad: Card[]; xi: XiPayload; budget: number; totalCost: number; diff: { out: Card[]; in: Card[] } } | null } | null>(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<{ chip: 'freehit' | 'wildcard'; event: number } | null>(null);

  useEffect(() => {
    void api.get<{ teams: { id: number; name: string; playerCount: number }[] }>('/api/teams').then((r) => {
      setTeams(r.teams);
      const full = r.teams.find((t) => t.playerCount === 15);
      if (full) setTeamId(full.id);
    });
  }, []);

  useEffect(() => {
    if (!teamId) return;
    setError('');
    void api
      .post<typeof data>('/api/modes/chips', { teamId, chip: chosen?.chip ?? null, event: chosen?.event ?? null })
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [teamId, chosen]);

  return (
    <div className="container">
      <section className="section">
        <p className="kicker">Mode · Free Hit / Wildcard</p>
        <div className="section-head">
          <h2 className="section-title">Chip timing, decided by the fixtures</h2>
          <select className="input-paper" style={{ width: 220 }} value={teamId ?? ''} onChange={(e) => setTeamId(Number(e.target.value) || null)}>
            <option value="">— pick a saved team —</option>
            {teams.map((t) => (<option key={t.id} value={t.id}>{t.name} ({t.playerCount}/15)</option>))}
          </select>
        </div>
        {error && <div className="err-note">{error}</div>}
        {!teamId && <div className="warn-note">Chip planning is computed against one of <b>your</b> teams — create one under Your Teams (or upload a screenshot).</div>}

        {data && (
          <>
            <div className="grid-2" style={{ alignItems: 'start' }}>
              <div>
                <p className="kicker">Chip windows (26/27 two-set rules)</p>
                <div className="rankings-list">
                  {data.recommendations.map((r, i) => (
                    <div className="rank-item" key={i}>
                      <div className="rank-num">{String(i + 1).padStart(2, '0')}</div>
                      <div className="rank-body">
                        <h4>{CHIP_LABEL[r.chip]} <span className="mono muted" style={{ fontSize: '.7rem' }}>set {r.chip_set}</span></h4>
                        <p>
                          Best window: <b>GW{r.event}</b> · value +{n(r.value)} xPts
                          {r.urgency > 0 && <span className="badge brass" style={{ marginLeft: 8 }}>use-or-lose ({r.urgency})</span>}
                          {r.caveats.map((c, j) => (<span key={j} className="muted"> — {c}</span>))}
                        </p>
                      </div>
                      {(r.chip === 'freehit' || r.chip === 'wildcard') && (
                        <button className="chip-paper" onClick={() => setChosen({ chip: r.chip as 'freehit' | 'wildcard', event: r.event })}>
                          build squad
                        </button>
                      )}
                    </div>
                  ))}
                  {data.recommendations.length === 0 && <p className="muted" style={{ padding: 14 }}>All chips used, or no run yet.</p>}
                </div>
              </div>
              <div className="stack">
                <div className="stat-panel">
                  <h4>Fixture coverage of this team (next 3 GWs)</h4>
                  <div className="stat-row"><span>Coverage score</span><b>{data.coverage ? n(data.coverage.coverage_score) : '—'}</b></div>
                  {(data.coverage?.gaps ?? []).slice(0, 4).map((g, i) => (
                    <div className="stat-row" key={i}>
                      <span>Gap · GW{g.event} ({g.kind === 'attacking' ? 'attack' : 'clean sheet'})</span>
                      <b>lev {n(g.leverage)}</b>
                    </div>
                  ))}
                </div>
                <div className="card">
                  <p className="kicker">Fixture planner (DGW ≥2 · BGW 0)</p>
                  <div className="row" style={{ gap: 6 }}>
                    {data.gwFixtureCounts.map((g) => (
                      <span key={g.event} className="badge" style={{ background: g.fixtures >= 11 ? 'rgba(184,137,47,.2)' : g.fixtures < 10 ? 'rgba(178,58,46,.15)' : undefined }}>
                        GW{g.event}: {g.fixtures}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {data.chipSquad && (
              <div style={{ marginTop: 26 }}>
                <p className="kicker">{CHIP_LABEL[data.chipSquad.chip]} squad for GW{data.chipSquad.event} (budget {fmtPrice(data.chipSquad.budget)})</p>
                <div className="grid-2" style={{ alignItems: 'start' }}>
                  <PitchView {...toPitch(data.chipSquad.squad, data.chipSquad.xi, data.chipSquad.chip === 'freehit' ? 1 : 6)} />
                  <DiffView diff={data.chipSquad.diff} />
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────── Mode 3: Weekly ──
interface Move { out: string[]; in: string[]; deltaXpts: number; hitCost: number; netGain: number; outCards: Card[]; inCards: Card[] }

export function WeeklyModePage(): ReactNode {
  const [teams, setTeams] = useState<{ id: number; name: string; playerCount: number; free_transfers: number; bank: number }[]>([]);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [data, setData] = useState<{ best0: { reasons: { captain?: string; formation?: string } }; singles: Move[]; doubles: Move[]; hitAdvice: string; alerts: { web_name: string; injury_status: string; injury_detail: string }[]; priceRisk: { web_name: string; transfers_in_net: number }[]; captaincy: { web_name: string; score: string; reasons: { doubled_xpts?: number; label?: string } }[]; targets: { web_name: string; position: string; club: string; score: string }[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<{ teams: typeof teams }>('/api/teams').then((r) => {
      setTeams(r.teams);
      const full = r.teams.find((t) => t.playerCount === 15);
      if (full) setTeamId(full.id);
    });
  }, []);

  useEffect(() => {
    if (!teamId) return;
    setError('');
    setData(null);
    void api
      .post<typeof data>('/api/modes/weekly', { teamId, horizon: 3 })
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [teamId]);

  const team = teams.find((t) => t.id === teamId);

  return (
    <div className="container">
      <section className="section">
        <p className="kicker">Mode · Weekly</p>
        <div className="section-head">
          <h2 className="section-title">This week's moves</h2>
          <div className="row">
            {team && <span className="badge">FT: {team.free_transfers} · bank {fmtPrice(team.bank)}</span>}
            <select className="input-paper" style={{ width: 220 }} value={teamId ?? ''} onChange={(e) => setTeamId(Number(e.target.value) || null)}>
              <option value="">— pick a saved team —</option>
              {teams.map((t) => (<option key={t.id} value={t.id}>{t.name} ({t.playerCount}/15)</option>))}
            </select>
          </div>
        </div>
        {error && <div className="err-note">{error}</div>}
        {!teamId && <div className="warn-note">Weekly advice runs against one of <b>your</b> teams — create or upload one under Your Teams.</div>}

        {data && (
          <div className="grid-2" style={{ alignItems: 'start' }}>
            <div className="stack">
              <div className="card">
                <p className="kicker">Best 0-transfer move</p>
                <p>Captain <b className="serif">{data.captaincy[0]?.web_name ?? '—'}</b>, formation {data.best0.reasons.formation ?? '—'}. Bank the transfer if nothing below clears +1.5 xPts.</p>
              </div>
              <div className="card">
                <p className="kicker">Transfer suggestions (next 3 GWs)</p>
                {data.singles.length === 0 && <p className="muted">No single transfer beats your current XV. Hold.</p>}
                {data.singles.map((m, i) => (
                  <div key={i} className="spread" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                    <span>
                      <b className="rc-down">{m.outCards.map((c) => c.web_name).join(', ')}</b> →{' '}
                      <b className="rc-up">{m.inCards.map((c) => c.web_name).join(', ')}</b>
                      {m.inCards[0]?.ai_rationale && <span className="muted" style={{ fontSize: '.8rem' }}> — “{m.inCards[0].ai_rationale}”</span>}
                    </span>
                    <span className="mono" style={{ whiteSpace: 'nowrap' }}>+{m.netGain.toFixed(2)} xP</span>
                  </div>
                ))}
                {data.doubles.length > 0 && (
                  <>
                    <p className="kicker" style={{ marginTop: 16 }}>Double moves</p>
                    {data.doubles.slice(0, 3).map((m, i) => (
                      <div key={i} className="spread" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                        <span>
                          <b className="rc-down">{m.outCards.map((c) => c.web_name).join(' + ')}</b> →{' '}
                          <b className="rc-up">{m.inCards.map((c) => c.web_name).join(' + ')}</b>
                          {m.hitCost > 0 && <span className="badge bad" style={{ marginLeft: 6 }}>−{m.hitCost}</span>}
                        </span>
                        <span className="mono">net +{m.netGain.toFixed(2)}</span>
                      </div>
                    ))}
                  </>
                )}
                <div className="ok-note" style={{ marginTop: 12 }}>{data.hitAdvice}</div>
              </div>
            </div>

            <div className="stack">
              <div className="stat-panel">
                <h4>Captaincy pool</h4>
                {data.captaincy.map((c, i) => (
                  <div className="stat-row" key={i}>
                    <span>{c.web_name} {c.reasons.label === 'ceiling_pick' && '· ceiling'}</span>
                    <b>{n(c.score)}</b>
                  </div>
                ))}
              </div>
              {data.alerts.length > 0 && (
                <div className="card">
                  <p className="kicker" style={{ color: 'var(--brick)' }}>Injury alerts in your squad</p>
                  {data.alerts.map((a, i) => (
                    <p key={i} style={{ fontSize: '.88rem' }}><b>{a.web_name}</b> — <span className="badge bad">{a.injury_status}</span> {a.injury_detail}</p>
                  ))}
                </div>
              )}
              {data.priceRisk.length > 0 && (
                <div className="card">
                  <p className="kicker">Price-drop risk</p>
                  {data.priceRisk.map((p, i) => (
                    <p key={i} className="mono" style={{ fontSize: '.84rem' }}>{p.web_name} · net {p.transfers_in_net.toLocaleString()}</p>
                  ))}
                </div>
              )}
              <div className="card">
                <p className="kicker">Match-engine targets this GW</p>
                {data.targets.map((t, i) => (
                  <div className="spread" key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)', fontSize: '.88rem' }}>
                    <span><b className="serif">{t.web_name}</b> <span className="mono muted" style={{ fontSize: '.7rem' }}>{t.position} · {t.club}</span></span>
                    <span className="mono">{n(t.score)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
