import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Loading } from '../components/Layout';

interface Candidate {
  uid: string;
  web_name: string;
  position: string;
  rank: number | null;
  preChecked: boolean;
  newsCount: number;
}

interface Estimate {
  tokens: number;
  credits: number;
  players: number;
  provider: string | null;
  note?: string;
  affordable?: boolean;
  balance?: number;
}

interface Progress {
  runId: number;
  stage: string;
  pct: number;
  done?: boolean;
  error?: string;
  report?: {
    tokens?: { prompt: number; completion: number; cached: number; credits: number };
    ai?: Record<string, unknown>;
    degradations?: string[];
    stages?: Record<string, number>;
  };
}

const STAGE_LABELS: Record<string, string> = {
  news_pull: '1 · Pulling news & injuries',
  ingest: '2 · Refreshing FPL data',
  stats: '3 · Statistical engine',
  match: '4 · Match engine',
  ai_pass: '5 · AI analysis',
  carry_forward: '6 · Carrying forward previous verdicts',
  rerank: '7 · Re-ranking',
  complete: 'Complete',
  failed: 'Failed',
};

export function RunScreen(): ReactNode {
  const { user, refresh } = useAuth();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [aiProvider, setAiProvider] = useState<{ key: string } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [skipAi, setSkipAi] = useState(false);
  const [newsInfo, setNewsInfo] = useState<{ providerEnabled: boolean; recentCount: number }>({ providerEnabled: true, recentCount: 0 });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    void api
      .get<{
        candidates: Candidate[];
        savedExclusions: string[];
        aiProvider: { key: string } | null;
        newsProviderEnabled?: boolean;
        recentNewsCount?: number;
      }>('/api/runs/prepare')
      .then((r) => {
        setCandidates(r.candidates);
        setAiProvider(r.aiProvider);
        setNewsInfo({ providerEnabled: r.newsProviderEnabled ?? false, recentCount: r.recentNewsCount ?? 0 });
        const pre = new Set<string>([...r.savedExclusions, ...r.candidates.filter((c) => c.preChecked).map((c) => c.uid)]);
        setExcluded(pre);
      });
    // attach if a run is already live
    void api.get<{ live: { id: number } | null }>('/api/runs/live').then((r) => {
      if (r.live) attach(r.live.id);
    });
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!candidates || candidates.length === 0) return;
    const t = setTimeout(() => {
      void api
        .post<Estimate>('/api/runs/estimate', { excluded: [...excluded] })
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, 400);
    return () => clearTimeout(t);
  }, [excluded, candidates]);

  const attach = (runId: number): void => {
    esRef.current?.close();
    const es = new EventSource(`/api/runs/${runId}/stream`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const p = JSON.parse(ev.data) as Progress;
      setProgress(p);
      if (p.done) {
        es.close();
        void refresh(); // token balance changed
      }
    };
    es.onerror = () => es.close();
  };

  const launch = async (): Promise<void> => {
    setError('');
    setProgress(null);
    try {
      const r = await api.post<{ runId: number; attached: boolean }>('/api/runs', { excluded: [...excluded], skipAi });
      attach(r.runId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const toggle = (uid: string): void => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  // bulk selection: clear everything, or skip the bottom N% by ranking
  const selectNone = (): void => setExcluded(new Set());
  const selectBottomPct = (pctBottom: number): void => {
    if (!candidates) return;
    const ranked = [...candidates].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    const keep = Math.floor(ranked.length * (1 - pctBottom / 100));
    setExcluded(new Set(ranked.slice(keep).map((c) => c.uid)));
  };

  if (!candidates) return <Loading />;
  const running = progress != null && !progress.done;

  return (
    <div className="container">
      <section className="section">
        <p className="kicker">The Run</p>
        <div className="section-head">
          <h2 className="section-title">News → AI → stats → re-rank</h2>
        </div>

        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="stack">
            <div className="stat-panel">
              <h4>Pre-flight</h4>
              <div className="stat-row"><span>AI provider</span><b data-testid="alive-provider">{aiProvider?.key ?? 'none'}</b></div>
              <div className="stat-row"><span>Players eligible</span><b>{estimate?.players ?? '—'}</b></div>
              <div className="stat-row"><span>Estimated tokens</span><b>{estimate ? `~${estimate.tokens.toLocaleString()}` : '—'}</b></div>
              <div className="stat-row"><span>Estimated credits</span><b data-testid="estimate-credits">{estimate ? `≈ ${estimate.credits}` : '—'}</b></div>
              <div className="stat-row"><span>Your balance</span><b>{user?.role === 'admin' ? '∞ (admin)' : user?.tokenBalance.toLocaleString()}</b></div>
              {estimate?.note && <p style={{ marginTop: 10, fontSize: '.82rem', color: '#B9C2D6' }}>{estimate.note}</p>}
              {estimate?.players === 0 && !skipAi && (
                <p style={{ marginTop: 10, fontSize: '.82rem', color: '#B9C2D6' }} data-testid="eligible-reason">
                  {!newsInfo.providerEnabled
                    ? 'Nobody to analyse: no news provider is enabled, so the AI has nothing new to read. Enable NewsData.io in Admin → Data providers, or untick some skipped players.'
                    : newsInfo.recentCount === 0
                      ? 'Nobody to analyse yet: no news has arrived in the last 7 days. The news pull at the start of this run may bring some in.'
                      : 'Nobody to analyse: every player is either on the skip list or has no new news since their last analysis.'}
                </p>
              )}
              <div style={{ marginTop: 18 }} className="row">
                <button className="btn-glass-dark" onClick={() => void launch()} disabled={running} data-testid="run-launch">
                  {running ? 'Running…' : '▶ Launch run'}
                </button>
                <label className="chip-glass" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={skipAi} onChange={(e) => setSkipAi(e.target.checked)} style={{ accentColor: 'var(--brass)' }} />
                  statistical only
                </label>
              </div>
              {estimate && estimate.affordable === false && (
                <div className="err-note" style={{ marginTop: 12 }}>
                  You're out of credits for this run. Contact your admin to top up — or exclude more players.
                </div>
              )}
            </div>

            {error && <div className="err-note" data-testid="run-error">{error}</div>}

            {progress && (
              <div className="card" data-testid="run-progress">
                <p className="kicker">{progress.error ? 'Run failed' : 'Live progress'}</p>
                <div className="progress-track" style={{ marginBottom: 12 }}>
                  <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
                </div>
                <p className="mono" style={{ fontSize: '.85rem' }} data-testid="run-stage">
                  {STAGE_LABELS[progress.stage] ?? progress.stage} — {progress.pct}%
                </p>
                {progress.error && <div className="err-note">{progress.error}</div>}
                {progress.report && (
                  <div style={{ marginTop: 14 }} data-testid="run-report">
                    <p className="kicker" style={{ color: 'var(--green-up)' }}>Token report</p>
                    <p style={{ fontSize: '.9rem' }}>
                      This run used <b className="mono">{(progress.report.tokens?.prompt ?? 0).toLocaleString()}</b> prompt +{' '}
                      <b className="mono">{(progress.report.tokens?.completion ?? 0).toLocaleString()}</b> completion tokens
                      {(progress.report.tokens?.cached ?? 0) > 0 && <> (of which <b className="mono">{progress.report.tokens!.cached.toLocaleString()}</b> cache-read)</>}{' '}
                      = <b className="mono">{progress.report.tokens?.credits ?? 0} credits</b>.
                    </p>
                    {(progress.report.degradations?.length ?? 0) > 0 && (
                      <div className="warn-note" style={{ marginTop: 10 }}>
                        {progress.report.degradations!.map((d, i) => (<div key={i}>· {d}</div>))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card" style={{ maxHeight: 560, overflowY: 'auto' }}>
            <p className="kicker">AI skip list ({excluded.size} skipped)</p>
            <p className="muted" style={{ fontSize: '.82rem', marginBottom: 10 }}>
              Checked players keep their previous AI verdict and cost nothing. Players without fresh news are skipped automatically either way.
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              <button className="chip-paper" onClick={selectNone} data-testid="excl-none">Unselect all</button>
              {[20, 30, 40, 50, 60].map((p) => (
                <button key={p} className="chip-paper" onClick={() => selectBottomPct(p)} data-testid={`excl-bottom-${p}`}>
                  Bottom {p}%
                </button>
              ))}
            </div>
            {candidates.length === 0 && <p className="muted">Rankings appear after your first update — run one and this list fills in.</p>}
            <div className="stack" style={{ gap: 4 }}>
              {candidates.map((c) => (
                <label key={c.uid} className="spread" style={{ padding: '5px 8px', borderBottom: '1px solid var(--line)', cursor: 'pointer', fontSize: '.88rem' }}>
                  <span>
                    <input type="checkbox" checked={excluded.has(c.uid)} onChange={() => toggle(c.uid)} style={{ marginRight: 10, accentColor: 'var(--brick)' }} />
                    <b className="serif">{c.web_name}</b> <span className="mono muted" style={{ fontSize: '.7rem' }}>{c.position} · rank {c.rank ?? '—'}</span>
                  </span>
                  <span className="mono muted" style={{ fontSize: '.72rem' }}>{c.newsCount > 0 ? `${c.newsCount} news` : 'no news'}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
