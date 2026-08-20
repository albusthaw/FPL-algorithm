import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, n, fmtPrice, type MatrixPlayer } from '../api';
import { RankChange, Loading } from '../components/Layout';

export function PlayersPage(): ReactNode {
  const [players, setPlayers] = useState<MatrixPlayer[] | null>(null);
  const [movement, setMovement] = useState<Record<string, number>>({});
  const [position, setPosition] = useState('');
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams();
    if (position) params.set('position', position);
    if (search) params.set('search', search);
    const t = setTimeout(() => {
      void api
        .get<{ players: MatrixPlayer[]; movement?: Record<string, number> }>(`/api/players?${params}`)
        .then((r) => {
          setPlayers(r.players);
          setMovement(r.movement ?? {});
        });
    }, 200);
    return () => clearTimeout(t);
  }, [position, search]);

  if (!players) return <Loading />;

  return (
    <div className="container">
      <section className="section">
        <div className="section-head">
          <div>
            <p className="kicker">The full board</p>
            <h2 className="section-title">Player rankings</h2>
          </div>
          <div className="row">
            {['', 'GK', 'DEF', 'MID', 'FWD'].map((pos) => (
              <button key={pos} className={`chip-paper ${position === pos ? 'active' : ''}`} onClick={() => setPosition(pos)}>
                {pos === '' ? 'All' : pos}
              </button>
            ))}
            <input
              className="input-paper"
              style={{ width: 190 }}
              placeholder="Search player…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="player-search"
            />
          </div>
        </div>
        <div className="table-wrap">
          <table data-testid="players-table">
            <thead>
              <tr>
                <th>Rank</th><th>Player</th><th>Pos</th><th>Club</th><th>Price</th><th>Score</th><th>AI</th>
                <th>xP1</th><th>xP3</th><th>xP6</th><th>Start%</th><th>Own%</th><th>Status</th><th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.uid} className="clickable" onClick={() => navigate(`/players/${p.uid}`)}>
                  <td className="mono muted">{p.rank_overall ?? '—'}</td>
                  <td className="team-name">{p.web_name}</td>
                  <td className="mono">{p.position}</td>
                  <td className="mono">{p.club}</td>
                  <td className="mono">{fmtPrice(p.price)}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>{n(p.overall_score)}</td>
                  <td className="mono">
                    {Number(p.ai_adjustment ?? 0) !== 0 ? (
                      <span className={Number(p.ai_adjustment) > 0 ? 'rc-up' : 'rc-down'}>
                        {Number(p.ai_adjustment) > 0 ? '+' : ''}{n(p.ai_adjustment, 0)}{p.ai_stale ? '·st' : ''}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="mono">{n(p.xpts_next1)}</td>
                  <td className="mono">{n(p.xpts_next3)}</td>
                  <td className="mono">{n(p.xpts_next6)}</td>
                  <td className="mono">{p.p_start_xi != null ? `${Math.round(Number(p.p_start_xi) * 100)}%` : '—'}</td>
                  <td className="mono">{n(p.selected_by_pct)}</td>
                  <td>{p.injury_status && p.injury_status !== 'fit' ? <span className="badge bad">{p.injury_status}</span> : <span className="badge ok">fit</span>}</td>
                  <td><RankChange delta={movement[p.uid]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

interface PlayerDetail {
  player: { uid: string; web_name: string; full_name: string; position: string; club: string; club_name: string; now_cost: number; status: string; news: string; selected_by_percent: string };
  matrix: Record<string, string | number | null> | null;
  history: { run_id: number; overall_score: string; stat_score: string; ai_adjustment: string; ai_rationale: string; rank_overall: number; computed_at: string }[];
  upcoming: { event: number; home: string; away: string; xpts: string; p_start: string; e_goals: string; e_assists: string; p_cs: string; components: Record<string, number> }[];
  recentMatches: { event: number; season: string; minutes: number; goals: number; assists: number; fpl_points: number; bonus: number; xg: string | null; xa: string | null; cbit: number; cbirt: number; was_home: boolean; kickoff_utc: string }[];
}

export function PlayerDetailPage(): ReactNode {
  const { uid } = useParams<{ uid: string }>();
  const [data, setData] = useState<PlayerDetail | null>(null);

  useEffect(() => {
    if (uid) void api.get<PlayerDetail>(`/api/players/${uid}`).then(setData);
  }, [uid]);

  if (!data) return <Loading />;
  const { player, matrix, history, upcoming, recentMatches } = data;
  const sparkMax = Math.max(1, ...history.map((h) => Number(h.overall_score)));

  return (
    <div className="container">
      <section className="section">
        <p className="kicker">{player.position} · {player.club_name} · {fmtPrice(player.now_cost)} · owned {n(player.selected_by_percent)}%</p>
        <div className="section-head">
          <h2 className="section-title">{player.full_name || player.web_name}</h2>
          <Link to="/players" className="btn-ghost">← All players</Link>
        </div>
        {player.news && <div className="warn-note">FPL flag: {player.news}</div>}

        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="stat-panel">
            <h4>Current matrix</h4>
            {matrix ? (
              <>
                <div className="stat-row"><span>Overall score</span><b>{n(matrix.overall_score as string)}</b></div>
                <div className="stat-row"><span>Statistical score</span><b>{n(matrix.stat_score as string)}</b></div>
                <div className="stat-row"><span>AI adjustment</span><b>{Number(matrix.ai_adjustment) > 0 ? '+' : ''}{n(matrix.ai_adjustment as string, 0)}{matrix.ai_stale ? ' (stale)' : ''}</b></div>
                <div className="stat-row"><span>xPts next 1 / 3 / 6</span><b>{n(matrix.xpts_next1 as string)} / {n(matrix.xpts_next3 as string)} / {n(matrix.xpts_next6 as string)}</b></div>
                <div className="stat-row"><span>Start probability</span><b>{Math.round(Number(matrix.p_start_xi) * 100)}%</b></div>
                <div className="stat-row"><span>xG / xA per 90 (shrunk)</span><b>{n(matrix.xg_per90 as string, 2)} / {n(matrix.xa_per90 as string, 2)}</b></div>
                <div className="stat-row"><span>Clean-sheet prob (next)</span><b>{Math.round(Number(matrix.xcs) * 100)}%</b></div>
                <div className="stat-row"><span>Rank overall / position</span><b>#{matrix.rank_overall} / #{matrix.rank_position}</b></div>
                {(matrix.ai_rationale as string) && <p style={{ marginTop: 12, fontSize: '.85rem', color: '#B9C2D6', fontStyle: 'italic' }}>“{matrix.ai_rationale as string}”</p>}
              </>
            ) : (
              <div className="stat-row"><span>No run yet</span><b>—</b></div>
            )}
          </div>

          <div className="stack">
            <div className="card">
              <p className="kicker">Score history (last {history.length} runs)</p>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }} data-testid="sparkline">
                {history.slice().reverse().map((h) => (
                  <div
                    key={h.run_id}
                    title={`run #${h.run_id}: ${n(h.overall_score)}`}
                    style={{ flex: 1, minWidth: 3, height: `${(Number(h.overall_score) / sparkMax) * 100}%`, background: 'var(--brass)', borderRadius: 2 }}
                  />
                ))}
              </div>
            </div>
            <div className="card">
              <p className="kicker">Upcoming fixtures (this run)</p>
              <div className="table-wrap">
                <table style={{ minWidth: 480 }}>
                  <thead><tr><th>GW</th><th>Fixture</th><th>xPts</th><th>Start</th><th>xG</th><th>xA</th><th>CS</th></tr></thead>
                  <tbody>
                    {upcoming.map((u, i) => (
                      <tr key={i}>
                        <td className="mono">{u.event}</td>
                        <td>{u.home} v {u.away}</td>
                        <td className="mono" style={{ fontWeight: 700 }}>{n(u.xpts)}</td>
                        <td className="mono">{Math.round(Number(u.p_start) * 100)}%</td>
                        <td className="mono">{n(u.e_goals, 2)}</td>
                        <td className="mono">{n(u.e_assists, 2)}</td>
                        <td className="mono">{Math.round(Number(u.p_cs) * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 28 }}>
          <p className="kicker">Recent matches</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Season</th><th>GW</th><th>Venue</th><th>Min</th><th>G</th><th>A</th><th>xG</th><th>xA</th><th>CBIT</th><th>Bonus</th><th>Pts</th></tr></thead>
              <tbody>
                {recentMatches.map((m, i) => (
                  <tr key={i}>
                    <td className="mono">{m.season}</td>
                    <td className="mono">{m.event}</td>
                    <td className="mono">{m.was_home ? 'H' : 'A'}</td>
                    <td className="mono">{m.minutes}</td>
                    <td className="mono">{m.goals}</td>
                    <td className="mono">{m.assists}</td>
                    <td className="mono">{m.xg != null ? n(m.xg, 2) : '—'}</td>
                    <td className="mono">{m.xa != null ? n(m.xa, 2) : '—'}</td>
                    <td className="mono">{m.cbit}</td>
                    <td className="mono">{m.bonus}</td>
                    <td className="mono" style={{ fontWeight: 700 }}>{m.fpl_points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
