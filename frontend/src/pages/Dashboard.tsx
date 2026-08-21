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
  reasons: {
    dominant?: string;
    // B1 (v1.4.3): the published match preview
    preview?: { p_home: number; p_draw: number; p_away: number; top_scorelines: { score: string; p: number }[] };
  };
}

// C5 (v1.4.3): dashboard news feed with signal badges + player chips
interface FeedItem {
  id: number;
  title: string;
  source_name: string;
  source_tier: number;
  published_at: string | null;
  fetched_at: string;
  signals: string[];
  story_items: string;
  players: { uid: string; web_name: string; photo: string | null }[];
}

const SIGNAL_BADGE: Record<string, { label: string; bad: boolean }> = {
  disciplinary: { label: 'discipline', bad: true },
  unprofessional: { label: 'conduct', bad: true },
  transfer_talk: { label: 'transfer', bad: true },
  contract_dispute: { label: 'contract', bad: true },
  personal_event: { label: 'personal', bad: true },
  morale_boost: { label: 'boost', bad: false },
  managerial_change: { label: 'manager', bad: true },
};

export function DashboardPage(): ReactNode {
  const [players, setPlayers] = useState<MatrixPlayer[] | null>(null);
  const [movement, setMovement] = useState<Record<string, number>>({});
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [runId, setRunId] = useState<number | null>(null);

  useEffect(() => {
    void api
      .get<{ feed: FeedItem[] }>('/api/news/feed?limit=8')
      .then((r) => setFeed(r.feed))
      .catch(() => setFeed([]));
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
            <p className="kicker">Power Rankings</p>
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
              <div className="matchup-feature" data-testid="dashboard-previews">
                <p className="kicker">Match engine · previews</p>
                {insights.map((ins) => (
                  <div key={ins.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <div className="spread">
                      <span className="serif" style={{ fontWeight: 600 }}>
                        {ins.home} v {ins.away}
                      </span>
                      <span className="mono" style={{ fontSize: '.76rem' }}>
                        {ins.reasons?.dominant === 'clean_sheet' ? 'CS' : 'ATT'} {n(ins.mci)}
                      </span>
                    </div>
                    {ins.reasons?.preview && (
                      <p className="mono" style={{ fontSize: '.72rem', marginTop: 4, opacity: 0.85 }}>
                        {Math.round(ins.reasons.preview.p_home * 100)}% / {Math.round(ins.reasons.preview.p_draw * 100)}% / {Math.round(ins.reasons.preview.p_away * 100)}%
                        {ins.reasons.preview.top_scorelines[0] && <> · likely {ins.reasons.preview.top_scorelines[0].score}</>}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {feed.length > 0 && (
              <div className="card" data-testid="dashboard-news-feed">
                <p className="kicker">Newsroom · latest stories</p>
                {feed.map((f) => (
                  <div key={f.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <p style={{ fontSize: '.86rem', lineHeight: 1.35 }}>
                      {f.title}
                      <span className="mono muted" style={{ fontSize: '.68rem' }}> — {f.source_name}{Number(f.story_items) > 1 ? ` +${Number(f.story_items) - 1} more` : ''}</span>
                    </p>
                    {((f.signals ?? []).length > 0 || f.players.length > 0) && (
                      <p className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                        {(f.signals ?? []).map((s) => (
                          <span key={s} className={`badge ${SIGNAL_BADGE[s]?.bad ? 'bad' : 'ok'}`} style={{ fontSize: '.64rem' }}>{SIGNAL_BADGE[s]?.label ?? s}</span>
                        ))}
                        {f.players.slice(0, 3).map((p) => (
                          <Link key={p.uid} to={`/players/${p.uid}`} className="badge" style={{ fontSize: '.64rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {p.photo && <img src={p.photo} alt="" style={{ width: 14, height: 18, objectFit: 'cover', borderRadius: 2 }} />}
                            {p.web_name}
                          </Link>
                        ))}
                      </p>
                    )}
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
