import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, fmtPrice, n, type MatrixPlayer } from '../api';
import { Loading } from '../components/Layout';
import { PitchView, type PitchPlayer } from '../components/PitchView';

interface TeamRow { id: number; name: string; bank: number; free_transfers: number; playerCount: number; updated_at: string }
interface TeamPlayerRow { player_uid: string; slot: number; is_captain: boolean; is_vice: boolean; bench_position: number | null; web_name: string; position: string; price: number; club: string; status: string }
interface TeamDetail { team: TeamRow & { players: TeamPlayerRow[]; notes: string; chips_used: { chip: string; set: number }[] }; valuation: { score: number; pointsPotential: number; benchStrength: number; captaincyQuality: number; budgetEfficiency: number } | null }

interface ResolvedSlot {
  parsed: { name: string; club: string | null; price: number | null; captain: boolean; vice: boolean; bench_position: number | null };
  best: string | null;
  ambiguous: boolean;
  candidates: { uid: string; web_name: string; club: string; position: string; price: number; similarity: number }[];
}

export function TeamsPage(): ReactNode {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [newName, setNewName] = useState('');
  const navigate = useNavigate();

  const load = (): void => {
    void api.get<{ teams: TeamRow[] }>('/api/teams').then((r) => setTeams(r.teams));
  };
  useEffect(load, []);

  const create = async (): Promise<void> => {
    if (!newName.trim()) return;
    const r = await api.post<{ team: { id: number } }>('/api/teams', { name: newName.trim() });
    navigate(`/teams/${r.team.id}`);
  };

  if (!teams) return <Loading />;

  return (
    <div className="container">
      <section className="section">
        <p className="kicker">Your Teams · unlimited</p>
        <div className="section-head">
          <h2 className="section-title">Saved teams</h2>
          <div className="row">
            <input className="input-paper" style={{ width: 200 }} placeholder="New team name…" value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="new-team-name" />
            <button className="btn-glass" onClick={() => void create()} data-testid="new-team-create">Create</button>
          </div>
        </div>
        <div className="cards-grid" data-testid="teams-grid">
          {teams.map((t) => (
            <Link to={`/teams/${t.id}`} key={t.id} className="card" style={{ display: 'block' }}>
              <div className="spread">
                <h3 className="serif" style={{ fontSize: '1.15rem' }}>{t.name}</h3>
                <span className={`badge ${t.playerCount === 15 ? 'ok' : 'brass'}`}>{t.playerCount}/15</span>
              </div>
              <p className="mono muted" style={{ fontSize: '.76rem', marginTop: 8 }}>
                bank {fmtPrice(t.bank)} · FT {t.free_transfers} · updated {new Date(t.updated_at).toLocaleDateString()}
              </p>
            </Link>
          ))}
          {teams.length === 0 && <p className="muted">No teams yet. Create one, or upload a screenshot inside a new team.</p>}
        </div>
      </section>
    </div>
  );
}

export function TeamDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const teamId = Number(id);
  const navigate = useNavigate();
  const [data, setData] = useState<TeamDetail | null>(null);
  const [error, setError] = useState('');
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerResults, setPickerResults] = useState<MatrixPlayer[]>([]);
  const [resolved, setResolved] = useState<ResolvedSlot[] | null>(null);
  const [uploadInfo, setUploadInfo] = useState<{ uploadId: number; credits: number; provider: string } | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (): void => {
    void api.get<TeamDetail>(`/api/teams/${teamId}`).then(setData).catch((err) => setError(String(err)));
  };
  useEffect(load, [teamId]);

  useEffect(() => {
    if (pickerSearch.length < 2) {
      setPickerResults([]);
      return;
    }
    const t = setTimeout(() => {
      void api.get<{ players: MatrixPlayer[] }>(`/api/players?search=${encodeURIComponent(pickerSearch)}`).then((r) => setPickerResults(r.players.slice(0, 6)));
    }, 250);
    return () => clearTimeout(t);
  }, [pickerSearch]);

  if (!data) return <Loading />;
  const { team, valuation } = data;

  const starters = team.players.filter((p) => p.bench_position == null);
  const bench = team.players.filter((p) => p.bench_position != null).sort((a, b) => (a.bench_position ?? 0) - (b.bench_position ?? 0));
  const toPitch = (rows: TeamPlayerRow[]): PitchPlayer[] =>
    rows.map((p) => ({ uid: p.player_uid, web_name: p.web_name, position: p.position, price: p.price, isCaptain: p.is_captain, isVice: p.is_vice }));

  const savePlayers = async (players: { uid: string; slot: number; isCaptain: boolean; isVice: boolean; benchPosition: number | null }[]): Promise<void> => {
    setError('');
    try {
      await api.put(`/api/teams/${teamId}`, {
        name: team.name,
        bank: team.bank,
        freeTransfers: team.free_transfers,
        chipsUsed: team.chips_used ?? [],
        notes: team.notes ?? '',
        players,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const currentPayload = (): { uid: string; slot: number; isCaptain: boolean; isVice: boolean; benchPosition: number | null }[] =>
    team.players.map((p) => ({ uid: p.player_uid, slot: p.slot, isCaptain: p.is_captain, isVice: p.is_vice, benchPosition: p.bench_position }));

  const addPlayer = (uid: string): void => {
    if (team.players.length >= 15 || team.players.some((p) => p.player_uid === uid)) return;
    const usedSlots = new Set(team.players.map((p) => p.slot));
    let slot = 1;
    while (usedSlots.has(slot)) slot++;
    const isBench = team.players.filter((p) => p.bench_position == null).length >= 11;
    const benchUsed = team.players.filter((p) => p.bench_position != null).length;
    void savePlayers([...currentPayload(), { uid, slot, isCaptain: false, isVice: false, benchPosition: isBench ? benchUsed + 1 : null }]);
    setPickerSearch('');
  };

  const removePlayer = (uid: string): void => {
    void savePlayers(currentPayload().filter((p) => p.uid !== uid));
  };

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    setError('');
    try {
      const r = await api.upload<{ uploadId: number; credits: number; provider: string; resolved: ResolvedSlot[] }>('/api/teams/upload-image', file);
      setResolved(r.resolved);
      setUploadInfo({ uploadId: r.uploadId, credits: r.credits, provider: r.provider });
      const initial: Record<number, string> = {};
      r.resolved.forEach((slot, i) => {
        if (slot.best) initial[i] = slot.best;
      });
      setChoices(initial);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const confirmUpload = async (): Promise<void> => {
    if (!resolved || !uploadInfo) return;
    const players = resolved
      .map((slot, i) => ({ slot, uid: choices[i] }))
      .filter((x): x is { slot: ResolvedSlot; uid: string } => !!x.uid)
      .map((x, idx) => ({
        uid: x.uid,
        slot: idx + 1,
        isCaptain: x.slot.parsed.captain,
        isVice: x.slot.parsed.vice,
        benchPosition: x.slot.parsed.bench_position,
      }));
    if (players.length !== 15) {
      setError(`all 15 slots must be resolved (${players.length}/15)`);
      return;
    }
    try {
      await api.post('/api/teams/confirm-upload', { uploadId: uploadInfo.uploadId, teamId, name: team.name, players });
      setResolved(null);
      setUploadInfo(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="container">
      <section className="section">
        <p className="kicker">Your Teams</p>
        <div className="section-head">
          <h2 className="section-title">{team.name}</h2>
          <div className="row">
            <span className="badge">bank {fmtPrice(team.bank)}</span>
            <span className="badge">FT {team.free_transfers}</span>
            <button className="chip-paper" onClick={() => void api.post<{ team: { id: number } }>(`/api/teams/${teamId}/clone`).then((r) => navigate(`/teams/${r.team.id}`))}>Clone</button>
            <button className="chip-paper" onClick={() => fileRef.current?.click()} data-testid="upload-btn">
              {uploading ? 'Parsing…' : '📷 Sync from screenshot'}
            </button>
            <button className="chip-paper" style={{ color: 'var(--brick)' }} onClick={() => { if (confirm('Delete this team?')) void api.del(`/api/teams/${teamId}`).then(() => navigate('/teams')); }}>Delete</button>
            <Link to="/teams" className="btn-ghost">← All teams</Link>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        {error && <div className="err-note" data-testid="team-error">{error}</div>}

        {resolved && (
          <div className="card-shade" style={{ marginBottom: 24 }} data-testid="confirm-screen">
            <p className="kicker">Confirmation required — parsed by {uploadInfo?.provider} ({uploadInfo?.credits} credits). Nothing is saved until you confirm.</p>
            <div className="table-wrap">
              <table style={{ minWidth: 560 }}>
                <thead><tr><th>#</th><th>Parsed</th><th>Resolves to</th><th>Confidence</th></tr></thead>
                <tbody>
                  {resolved.map((slot, i) => (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td>{slot.parsed.name} {slot.parsed.club && <span className="mono muted">({slot.parsed.club})</span>} {slot.parsed.captain && '©'}{slot.parsed.bench_position != null && <span className="badge">bench {slot.parsed.bench_position}</span>}</td>
                      <td>
                        {slot.ambiguous ? (
                          <select className="input-paper" style={{ maxWidth: 260 }} value={choices[i] ?? ''} onChange={(e) => setChoices((c) => ({ ...c, [i]: e.target.value }))} data-testid={`picker-${i}`}>
                            <option value="">Did you mean…</option>
                            {slot.candidates.map((c) => (
                              <option key={c.uid} value={c.uid}>{c.web_name} ({c.club}, {c.position}, {fmtPrice(c.price)})</option>
                            ))}
                          </select>
                        ) : (
                          <b className="serif">{slot.candidates.find((c) => c.uid === choices[i])?.web_name ?? '—'}</b>
                        )}
                      </td>
                      <td className="mono">{slot.candidates[0] ? `${Math.round(slot.candidates[0].similarity * 100)}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn-glass" onClick={() => void confirmUpload()} data-testid="confirm-upload">Confirm team</button>
              <button className="chip-paper" onClick={() => { setResolved(null); setUploadInfo(null); }}>Discard</button>
            </div>
          </div>
        )}

        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div>
            {team.players.length > 0 ? (
              <PitchView starters={toPitch(starters)} bench={toPitch(bench)} onSelect={(uid) => { if (confirm('Remove this player from the team?')) removePlayer(uid); }} />
            ) : (
              <div className="warn-note">Empty team — search below to add players, or sync from a screenshot.</div>
            )}
            <div className="row" style={{ marginTop: 14 }}>
              <input className="input-paper" style={{ width: 240 }} placeholder="Add player…" value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} data-testid="team-add-search" />
              {pickerResults.map((p) => (
                <button key={p.uid} className="chip-paper" onClick={() => addPlayer(p.uid)}>
                  + {p.web_name} ({p.position} {fmtPrice(p.price)})
                </button>
              ))}
            </div>
          </div>
          <div className="stat-panel" data-testid="team-valuation">
            <h4>Team valuation (0–100)</h4>
            {valuation ? (
              <>
                <div className="stat-row"><span>Overall</span><b>{valuation.score}</b></div>
                <div className="stat-row"><span>Points potential</span><b>{valuation.pointsPotential}</b></div>
                <div className="stat-row"><span>Bench strength</span><b>{valuation.benchStrength}</b></div>
                <div className="stat-row"><span>Captaincy options</span><b>{valuation.captaincyQuality}</b></div>
                <div className="stat-row"><span>Budget efficiency</span><b>{valuation.budgetEfficiency}</b></div>
              </>
            ) : (
              <div className="stat-row"><span>{team.players.length === 15 ? 'Run the engine first' : 'Complete the 15-man squad'}</span><b>—</b></div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
