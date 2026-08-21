import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, n, pct, fmtPrice, type MatrixPlayer } from '../api';
import { RankChange, Loading } from '../components/Layout';

type SortKey =
  | 'rank_overall'
  | 'web_name'
  | 'position'
  | 'club'
  | 'price'
  | 'overall_score'
  | 'ai_adjustment'
  | 'xpts_next1'
  | 'xpts_next3'
  | 'xpts_next6'
  | 'p_start_xi'
  | 'selected_by_pct'
  | 'ep_next'
  | 'ict_index'
  | 'injury_status';

const NUMERIC_KEYS = new Set<SortKey>([
  'rank_overall', 'price', 'overall_score', 'ai_adjustment',
  'xpts_next1', 'xpts_next3', 'xpts_next6', 'p_start_xi', 'selected_by_pct',
  'ep_next', 'ict_index',
]);

export function PlayersPage(): ReactNode {
  const [players, setPlayers] = useState<MatrixPlayer[] | null>(null);
  const [movement, setMovement] = useState<Record<string, number>>({});
  const [position, setPosition] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('rank_overall');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const navigate = useNavigate();

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      // numbers usually want best-first on first click; names A→Z
      setSortDir(NUMERIC_KEYS.has(key) && key !== 'rank_overall' ? 'desc' : 'asc');
    }
  };

  const sorted = useMemo(() => {
    if (!players) return null;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...players].sort((a, b) => {
      const av = a[sortKey as keyof MatrixPlayer];
      const bv = b[sortKey as keyof MatrixPlayer];
      if (NUMERIC_KEYS.has(sortKey)) {
        const an = Number(av);
        const bn = Number(bv);
        const aa = Number.isFinite(an) ? an : sortDir === 'asc' ? Infinity : -Infinity;
        const bb = Number.isFinite(bn) ? bn : sortDir === 'asc' ? Infinity : -Infinity;
        return (aa - bb) * dir;
      }
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [players, sortKey, sortDir]);

  const Th = ({ k, children }: { k: SortKey; children: ReactNode }): ReactNode => (
    <th
      className="clickable"
      style={{ cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}
      onClick={() => toggleSort(k)}
      data-testid={`sort-${k}`}
      title="Click to sort"
    >
      {children}
      <span style={{ opacity: sortKey === k ? 1 : 0.25, marginLeft: 3 }}>
        {sortKey === k ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );

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

  if (!players || !sorted) return <Loading />;

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
                <Th k="rank_overall">Rank</Th><Th k="web_name">Player</Th><Th k="position">Pos</Th>
                <Th k="club">Club</Th><Th k="price">Price</Th><Th k="overall_score">Score</Th>
                <Th k="ai_adjustment">AI</Th><Th k="xpts_next1">xP1</Th><Th k="xpts_next3">xP3</Th>
                <Th k="xpts_next6">xP6</Th><Th k="p_start_xi">Start%</Th><Th k="selected_by_pct">Own%</Th>
                {/* A6 (v1.4.3): FPL's own benchmark + ICT — display columns */}
                <Th k="ep_next">FPL xP</Th><Th k="ict_index">ICT</Th>
                <Th k="injury_status">Status</Th><th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.uid} className="clickable" onClick={() => navigate(`/players/${p.uid}`)}>
                  <td className="mono muted">{p.rank_overall ?? '—'}</td>
                  <td className="team-name">{p.web_name}</td>
                  <td className="mono">{p.position}</td>
                  <td className="mono">{p.club}</td>
                  <td className="mono">{fmtPrice(p.price)}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>{n(p.overall_score)}</td>
                  <td className="mono">
                    {Number(p.ai_adjustment ?? 0) !== 0 ? (
                      <span
                        className={Number(p.ai_adjustment) > 0 ? 'rc-up' : 'rc-down'}
                        title={p.ai_stale ? 'carried forward from an earlier analysis' : 'from the latest analysis'}
                      >
                        {Number(p.ai_adjustment) > 0 ? '+' : ''}{n(p.ai_adjustment, 0)}{p.ai_stale ? '*' : ''}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="mono">{n(p.xpts_next1)}</td>
                  <td className="mono">{n(p.xpts_next3)}</td>
                  <td className="mono">{n(p.xpts_next6)}</td>
                  <td className="mono">{pct(p.p_start_xi)}</td>
                  <td className="mono">{n(p.selected_by_pct)}</td>
                  <td className="mono muted" title="FPL's own ep_next benchmark">{p.ep_next != null ? n(p.ep_next) : '—'}</td>
                  <td className="mono muted">{p.ict_index != null ? n(p.ict_index) : '—'}</td>
                  <td>{p.injury_status && p.injury_status !== 'fit' ? <span className="badge bad">{p.injury_status.replace(/_/g, ' ')}</span> : <span className="badge ok">fit</span>}</td>
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

// C5 (v1.4.3): the per-player news timeline
interface NewsTimelineItem {
  id: number;
  title: string;
  description: string | null;
  source_name: string;
  source_domain: string;
  source_tier: number;
  published_at: string | null;
  fetched_at: string;
  signals: string[];
  corroboration: number;
}

const TIMELINE_BADGE: Record<string, string> = {
  disciplinary: 'discipline',
  unprofessional: 'conduct',
  transfer_talk: 'transfer',
  contract_dispute: 'contract',
  personal_event: 'personal',
  morale_boost: 'boost',
  managerial_change: 'manager',
};

export function PlayerDetailPage(): ReactNode {
  const { uid } = useParams<{ uid: string }>();
  const [data, setData] = useState<PlayerDetail | null>(null);
  const [news, setNews] = useState<{ player: { photo: string | null }; timeline: NewsTimelineItem[] } | null>(null);

  useEffect(() => {
    if (!uid) return;
    void api.get<PlayerDetail>(`/api/players/${uid}`).then(setData);
    void api
      .get<{ player: { photo: string | null }; timeline: NewsTimelineItem[] }>(`/api/players/${uid}/news`)
      .then(setNews)
      .catch(() => setNews(null));
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
            <h4>Current assessment</h4>
            {matrix ? (
              <>
                <div className="stat-row"><span>Overall score</span><b>{n(matrix.overall_score as string)}</b></div>
                <div className="stat-row"><span>Statistical score</span><b>{n(matrix.stat_score as string)}</b></div>
                <div className="stat-row"><span>AI adjustment</span><b>{Number(matrix.ai_adjustment) > 0 ? '+' : ''}{n(matrix.ai_adjustment as string, 0)}{matrix.ai_stale ? ' (carried forward)' : ''}</b></div>
                <div className="stat-row"><span>Expected points next 1 / 3 / 6</span><b>{n(matrix.xpts_next1 as string)} / {n(matrix.xpts_next3 as string)} / {n(matrix.xpts_next6 as string)}</b></div>
                <div className="stat-row"><span>Start probability</span><b>{pct(matrix.p_start_xi as string)}</b></div>
                <div className="stat-row"><span>xG / xA per 90 (adjusted)</span><b>{n(matrix.xg_per90 as string, 2)} / {n(matrix.xa_per90 as string, 2)}</b></div>
                {matrix.p90 != null && (
                  <div className="stat-row" data-testid="player-quantiles">
                    <span>Next match floor / median / ceiling</span>
                    <b className="mono">{n(matrix.p10 as string, 0)} / {n(matrix.p50 as string, 0)} / {n(matrix.p90 as string, 0)} pts</b>
                  </div>
                )}
                <div className="stat-row"><span>Clean-sheet chance (next match)</span><b>{pct(matrix.xcs as string)}</b></div>
                <div className="stat-row"><span>Rank overall / position</span><b>#{matrix.rank_overall} / #{matrix.rank_position}</b></div>
                {(matrix.ai_rationale as string) && <p style={{ marginTop: 12, fontSize: '.85rem', color: '#B9C2D6', fontStyle: 'italic' }}>“{matrix.ai_rationale as string}”</p>}
              </>
            ) : (
              <div className="stat-row"><span>No run yet</span><b>—</b></div>
            )}
          </div>

          <div className="stack">
            <div className="card">
              <p className="kicker">Score history (last {history.length} {history.length === 1 ? 'update' : 'updates'})</p>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }} data-testid="sparkline">
                {history.length === 0 && <p className="muted" style={{ fontSize: '.85rem' }}>No score history yet — it builds up with each update you run.</p>}
                {history.slice().reverse().map((h) => (
                  <div
                    key={h.run_id}
                    title={`${new Date(h.computed_at).toLocaleDateString()}: ${n(h.overall_score)}`}
                    style={{ flex: 1, minWidth: 3, height: `${(Number(h.overall_score) / sparkMax) * 100}%`, background: 'var(--brass)', borderRadius: 2 }}
                  />
                ))}
              </div>
            </div>
            <div className="card">
              <p className="kicker">Upcoming fixtures</p>
              <div className="table-wrap">
                <table style={{ minWidth: 480 }}>
                  <thead><tr><th>GW</th><th>Fixture</th><th>xPts</th><th>Start</th><th>xG</th><th>xA</th><th>CS</th></tr></thead>
                  <tbody>
                    {upcoming.map((u, i) => (
                      <tr key={i}>
                        <td className="mono">{u.event}</td>
                        <td>{u.home} v {u.away}</td>
                        <td className="mono" style={{ fontWeight: 700 }}>{n(u.xpts)}</td>
                        <td className="mono">{pct(u.p_start)}</td>
                        <td className="mono">{n(u.e_goals, 2)}</td>
                        <td className="mono">{n(u.e_assists, 2)}</td>
                        <td className="mono">{pct(u.p_cs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {news && news.timeline.length > 0 && (
              <div className="card" data-testid="player-news-timeline">
                <p className="kicker">News timeline</p>
                {news.timeline.slice(0, 10).map((t) => (
                  <div key={t.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <p style={{ fontSize: '.85rem', lineHeight: 1.35 }}>
                      {t.title}
                      <span className="mono muted" style={{ fontSize: '.66rem' }}>
                        {' '}— {t.source_name || t.source_domain} · {new Date(t.published_at ?? t.fetched_at).toLocaleDateString()}
                        {t.corroboration > 1 ? ` · ${t.corroboration} sources` : ''}
                      </span>
                    </p>
                    {(t.signals ?? []).length > 0 && (
                      <p className="row" style={{ gap: 6, marginTop: 4 }}>
                        {(t.signals ?? []).map((s) => (
                          <span key={s} className={`badge ${s === 'morale_boost' ? 'ok' : 'bad'}`} style={{ fontSize: '.62rem' }}>{TIMELINE_BADGE[s] ?? s}</span>
                        ))}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
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
