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

// P2 (v1.4.2): every generated build is savable as a team (kind + source run)
function SaveBuildButton({ name, kind, sourceRunId, xi }: { name: string; kind: string; sourceRunId: number | null; xi: XiPayload }): ReactNode {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const save = async (): Promise<void> => {
    setState('saving');
    try {
      const players = [
        ...xi.starters.map((uid, i) => ({ uid, slot: i + 1, isCaptain: uid === xi.captain, isVice: uid === xi.vice, benchPosition: null })),
        ...xi.bench.map((uid, i) => ({ uid, slot: 12 + i, isCaptain: false, isVice: false, benchPosition: i + 1 })),
      ];
      await api.post('/api/teams', { name, kind, sourceRunId, players });
      setState('saved');
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
      setState('error');
    }
  };
  if (state === 'saved') return <span className="badge ok" data-testid={`saved-${kind}`}>Saved ✓ — see Your Teams</span>;
  return (
    <span className="row" style={{ gap: 8 }}>
      <button className="btn-glass" data-testid={`save-${kind}`} onClick={() => void save()} disabled={state === 'saving'}>
        {state === 'saving' ? 'Saving…' : 'Save as team'}
      </button>
      {state === 'error' && <span className="badge bad">{msg}</span>}
    </span>
  );
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
  const [result, setResult] = useState<{ runId: number; squad: Card[]; xi: XiPayload; totalCost: number; method: string; diff: { out: Card[]; in: Card[]; deltaXpts: number; deltaBudget: number } | null } | null>(null);
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
              <div className="row" style={{ marginTop: 12 }}>
                <SaveBuildButton name={`Initial XI (run ${result.runId})`} kind="initial_xi" sourceRunId={result.runId} xi={result.xi} />
              </div>
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
  const [data, setData] = useState<{ runId: number; recommendations: ChipRec[]; coverage: { coverage_score: string; gaps: { event: number; kind: string; leverage: number }[] } | null; gwFixtureCounts: { event: number; fixtures: number }[]; chipSquad: { chip: string; event: number; squad: Card[]; xi: XiPayload; budget: number; totalCost: number; diff: { out: Card[]; in: Card[] } } | null } | null>(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<{ chip: 'freehit' | 'wildcard'; event: number } | null>(null);

  useEffect(() => {
    void api.get<{ teams: { id: number; name: string; playerCount: number }[] }>('/api/teams').then((r) => {
      setTeams(r.teams);
      const full = r.teams.find((t) => t.playerCount === 15);
      if (full) setTeamId(Number(full.id));
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
                  <div>
                    <PitchView {...toPitch(data.chipSquad.squad, data.chipSquad.xi, data.chipSquad.chip === 'freehit' ? 1 : 6)} />
                    <div className="row" style={{ marginTop: 12 }}>
                      <SaveBuildButton
                        name={`${CHIP_LABEL[data.chipSquad.chip]} GW${data.chipSquad.event} (run ${data.runId})`}
                        kind={data.chipSquad.chip}
                        sourceRunId={data.runId}
                        xi={data.chipSquad.xi}
                      />
                    </div>
                  </div>
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
  const [data, setData] = useState<{ runId: number; xi: XiPayload; squad: Card[]; applied: { out: string[]; in: string[]; xi: XiPayload; squad: Card[] } | null; best0: { reasons: { captain?: string; formation?: string } }; singles: Move[]; doubles: Move[]; hitAdvice: string; alerts: { web_name: string; injury_status: string; injury_detail: string }[]; priceRisk: { web_name: string; transfers_in_net: number }[]; captaincy: { web_name: string; score: string; reasons: { doubled_xpts?: number; ceiling?: number; label?: string } }[]; targets: { web_name: string; position: string; club: string; score: string }[] } | null>(null);
  const [error, setError] = useState('');
  // P2 (v1.4.2): preview the XI after a suggested move is applied
  const [apply, setApply] = useState<{ out: string[]; in: string[] } | null>(null);

  useEffect(() => {
    void api.get<{ teams: typeof teams }>('/api/teams').then((r) => {
      setTeams(r.teams);
      const full = r.teams.find((t) => t.playerCount === 15);
      if (full) setTeamId(Number(full.id));
    });
  }, []);

  useEffect(() => {
    setApply(null);
  }, [teamId]);

  useEffect(() => {
    if (!teamId) return;
    setError('');
    void api
      .post<typeof data>('/api/modes/weekly', { teamId, horizon: 3, apply })
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [teamId, apply]);

  const team = teams.find((t) => t.id === teamId);
  const shownXi = data?.applied?.xi ?? data?.xi ?? null;
  const shownSquad = data?.applied?.squad ?? data?.squad ?? [];

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
              {shownXi && (
                <div data-testid="weekly-pitch">
                  <p className="kicker">
                    {data.applied ? 'Your best XI — after the previewed transfer' : 'Your best XI this week'}
                    <span className="mono muted" style={{ marginLeft: 8, fontSize: '.7rem' }}>{shownXi.xpts} xPts (C doubled)</span>
                  </p>
                  <PitchView {...toPitch(shownSquad, shownXi, 3)} />
                  <div className="row" style={{ marginTop: 12 }}>
                    <SaveBuildButton
                      name={`Weekly XI${data.applied ? ' (post-transfer)' : ''} (run ${data.runId})`}
                      kind="weekly"
                      sourceRunId={data.runId}
                      xi={shownXi}
                    />
                    {data.applied && (
                      <button className="chip-paper" onClick={() => setApply(null)}>reset preview</button>
                    )}
                  </div>
                </div>
              )}
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
                    <span className="row" style={{ gap: 6, whiteSpace: 'nowrap' }}>
                      <span className="mono">+{m.netGain.toFixed(2)} xP</span>
                      <button className="chip-paper" onClick={() => setApply({ out: m.out, in: m.in })}>preview XI</button>
                    </span>
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
                {/* B5 (v1.4.2): the displayed number IS the simulated P90 ceiling */}
                <h4>Captaincy pool (P90 ceiling)</h4>
                {data.captaincy.map((c, i) => (
                  <div className="stat-row" key={i}>
                    <span>{c.web_name}{c.reasons.doubled_xpts != null && <span className="mono" style={{ opacity: 0.7, fontSize: '.72rem' }}> · mean {c.reasons.doubled_xpts}</span>}</span>
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
