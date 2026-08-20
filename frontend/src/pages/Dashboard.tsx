import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, n, type MatrixPlayer } from '../api';
import { RankChange, Loading } from '../components/Layout';

interface RunRow {
  id: number;
  kind: string;
  status: string;
  ai_provider: string | null;
  credits: string;
  players_analysed: number;
  players_skipped: number;
  started_at: string;
  finished_at: string | null;
  degradations: string[] | null;
}

interface Insight {
  id: number;
  home: string;
  away: string;
  side: string;
  att_leverage: string;
  def_leverage: string;
  mci: string;
  kickoff_utc: string | null;
  reasons: { dominant?: string };
}

export function DashboardPage(): ReactNode {
  const [players, setPlayers] = useState<MatrixPlayer[] | null>(null);
  const [movement, setMovement] = useState<Record<string, number>>({});
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [runId, setRunId] = useState<number | null>(null);

  useEffect(() => {
    void api
      .get<{ runId: number | null; players: MatrixPlayer[]; movement?: Record<string, number> }>('/api/players')
      .then((r) => {
        setPlayers(r.players.slice(0, 8));
        setMovement(r.movement ?? {});
        setRunId(r.runId);
      });
    void api.get<{ runs: RunRow[] }>('/api/runs').then((r) => setRuns(r.runs.slice(0, 5)));
    void api
      .get<{ insights: Insight[] }>('/api/insights')
      .then((r) => setInsights(r.insights.slice(0, 3)))
      .catch(() => setInsights([]));
  }, []);

  if (!players) return <Loading />;
  const lastRun = runs.find((r) => r.status === 'complete');

  return (
    <div className="container">
      <section className="section" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <div className="grid-2 wide-left" style={{ alignItems: 'start' }}>
          <div>
            <p className="kicker">Power Rankings{runId ? ` · Run #${runId}` : ''}</p>
            <h2 className="section-title" style={{ marginBottom: 18 }}>The engine's current top picks</h2>
            {players.length === 0 || runId == null ? (
              <div className="warn-note">
                No completed run yet — head to the <Link to="/run" style={{ textDecoration: 'underline' }}>Run screen</Link> and press the button.
              </div>
            ) : (
              <div className="rankings-list" data-testid="dashboard-rankings">
                {players.map((p, i) => (
                  <div className="rank-item" key={p.uid}>
                    <div className="rank-num">{String(i + 1).padStart(2, '0')}</div>
                    <div className="rank-body">
                      <h4>
                        <Link to={`/players/${p.uid}`}>{p.web_name}</Link>{' '}
                        <span className="mono muted" style={{ fontSize: '.72rem' }}>
                          {p.position} · {p.club} · £{(p.price / 10).toFixed(1)}m
                        </span>
                      </h4>
                      <p>
                        Score {n(p.overall_score)} (stat {n(p.stat_score)}
                        {Number(p.ai_adjustment) !== 0 ? `, AI ${Number(p.ai_adjustment) > 0 ? '+' : ''}${n(p.ai_adjustment, 0)}` : ''}) ·
                        xPts next 3: {n(p.xpts_next3)} · start {Math.round(Number(p.p_start_xi) * 100)}%
                        {p.ai_rationale ? ` — “${p.ai_rationale}”` : ''}
                      </p>
                    </div>
                    <RankChange delta={movement[p.uid]} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="stack">
            <div className="stat-panel" data-testid="dashboard-statpanel">
              <h4>Last run at a glance</h4>
              {lastRun ? (
                <>
                  <div className="stat-row"><span>Run</span><b>#{lastRun.id}</b></div>
                  <div className="stat-row"><span>AI provider</span><b>{lastRun.ai_provider ?? 'skipped'}</b></div>
                  <div className="stat-row"><span>Players analysed</span><b>{lastRun.players_analysed}</b></div>
                  <div className="stat-row"><span>Skipped (no news/excluded)</span><b>{lastRun.players_skipped}</b></div>
                  <div className="stat-row"><span>Credits used</span><b>{lastRun.credits}</b></div>
                </>
              ) : (
                <div className="stat-row"><span>No runs yet</span><b>—</b></div>
              )}
              <div style={{ marginTop: 18 }}>
                <Link to="/run" className="btn-glass-dark" data-testid="dashboard-run-btn">▶ Run the engine</Link>
              </div>
            </div>

            {insights.length > 0 && (
              <div className="matchup-feature">
                <p className="kicker">Match engine · highest leverage</p>
                {insights.map((ins) => (
                  <div key={ins.id} className="spread" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <span className="serif" style={{ fontWeight: 600 }}>
                      {ins.home} v {ins.away}
                    </span>
                    <span className="mono" style={{ fontSize: '.76rem' }}>
                      {ins.reasons?.dominant === 'clean_sheet' ? 'CS' : 'ATT'} {n(ins.mci)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <p className="kicker">History</p>
            <h2 className="section-title">Recent runs</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Run</th><th>Kind</th><th>Status</th><th>AI</th><th>Analysed</th><th>Credits</th><th>Started</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="mono">#{r.id}</td>
                  <td>{r.kind}</td>
                  <td><span className={`badge ${r.status === 'complete' ? 'ok' : r.status === 'failed' ? 'bad' : 'brass'}`}>{r.status}</span></td>
                  <td>{r.ai_provider ?? '—'}</td>
                  <td className="mono">{r.players_analysed}</td>
                  <td className="mono">{r.credits}</td>
                  <td className="mono">{new Date(r.started_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
