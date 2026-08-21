/**
 * Match Engine (fpl-engines-plan.md Part 5): fixture leverage, match
 * compatibility index, players-to-target, captaincy pool, coverage/gaps,
 * DGW/BGW, fixture swings, chip-window scoring under the 2026/27 two-set
 * rules. Reads only run-stamped predictions from the SAME run_id; writes
 * run-stamped insights, append-only.
 */
import type { Knex } from 'knex';
import { getConfig } from '../core/model-config.js';
import { pickStartingXi, type SquadRules } from '../fpl/rules.js';
import { log } from '../core/logger.js';

interface MatchEngineConfig {
  leverage_window_events: number;
  target_list_size: number;
  captaincy_pool_size: number;
  coverage_window_events: number;
  dgw_projection_events: number;
  differential_ownership_max: number;
  swing_threshold: number;
  chip_urgency_events: number;
  wc_horizon_events: number;
  wc_realisation?: number; // B6 (v1.4.5): ⚙ — was a hard-coded 0.35 (M5)
}

interface ChipRules {
  sets: { set: number; start_event: number; stop_event: number; chips: string[] }[];
}

export interface MatchEngineResult {
  insights: number;
  targets: number;
  chipRecs: number;
  coverageReports: number;
}

export async function runMatchEngine(db: Knex, runId: number): Promise<MatchEngineResult> {
  const cfg = await getConfig<MatchEngineConfig>(db, 'match_engine');
  const chipRules = await getConfig<ChipRules>(db, 'chip_rules');
  const scoring = await getConfig<{ goal: Record<string, number>; clean_sheet: Record<string, number>; assist: number; saves_per_point?: number }>(db, 'scoring_rules');

  const fxPreds = await db('fixture_predictions as fp')
    .join('fixtures as f', 'f.fixture_uid', 'fp.fixture_uid')
    .where('fp.run_id', runId)
    .select(
      'fp.*',
      'f.home_team_uid',
      'f.away_team_uid',
      'f.kickoff_utc',
      'f.state',
    );
  if (fxPreds.length === 0) return { insights: 0, targets: 0, chipRecs: 0, coverageReports: 0 };

  const events = [...new Set(fxPreds.map((f) => f.event as number))].sort((a, b) => a - b);
  const windowEvents = events.slice(0, cfg.leverage_window_events);

  // volatility flags: teams touched by unscheduled fixtures — and (B4/M6,
  // v1.4.5) teams with an all-competitions midweek inside the window
  const unscheduled = await db('fixtures').where('state', 'postponed').select('home_team_uid', 'away_team_uid');
  const volatileTeams = new Set(unscheduled.flatMap((f) => [f.home_team_uid, f.away_team_uid]));
  const teamStrengths = (await db('teams').whereNotNull('fpl_id').select('uid', 'strength')) as { uid: string; strength: { ext_fixtures?: string[] } | null }[];
  const now = Date.now();
  for (const t of teamStrengths) {
    const soonExt = (t.strength?.ext_fixtures ?? []).some((d) => {
      const ts = new Date(d).getTime();
      return Number.isFinite(ts) && ts > now && ts < now + 10 * 86_400_000;
    });
    if (soonExt) volatileTeams.add(t.uid);
  }

  // matrix for star density + targets
  const matrix = await db('player_matrix as pm')
    .join('players as p', 'p.uid', 'pm.player_uid')
    .where('pm.run_id', runId)
    .select('pm.player_uid', 'pm.overall_score', 'pm.stat_score', 'pm.p_start_xi', 'pm.selected_by_pct', 'pm.price', 'p.position', 'p.team_uid', 'p.web_name');
  const playersByTeam = new Map<string, typeof matrix>();
  for (const m of matrix) {
    (playersByTeam.get(m.team_uid) ?? playersByTeam.set(m.team_uid, []).get(m.team_uid)!).push(m);
  }
  const topDecileScore = quantile(matrix.map((m) => Number(m.overall_score)), 0.9);

  const pfp = await db('player_fixture_predictions').where('run_id', runId);
  const pfpByFixture = new Map<string, typeof pfp>();
  const pfpByPlayer = new Map<string, typeof pfp>();
  for (const row of pfp) {
    (pfpByFixture.get(row.fixture_uid) ?? pfpByFixture.set(row.fixture_uid, []).get(row.fixture_uid)!).push(row);
    (pfpByPlayer.get(row.player_uid) ?? pfpByPlayer.set(row.player_uid, []).get(row.player_uid)!).push(row);
  }
  const playerMeta = new Map(matrix.map((m) => [m.player_uid, m]));

  // ── leverage percentiles over the window
  const windowFx = fxPreds.filter((f) => windowEvents.includes(f.event));
  const attVals: number[] = [];
  const defVals: number[] = [];
  for (const f of windowFx) {
    attVals.push(Number(f.fdr_att_home), Number(f.fdr_att_away));
    defVals.push(Number(f.fdr_def_home), Number(f.fdr_def_away));
  }

  let insightsCount = 0;
  const insightRows: Record<string, unknown>[] = [];
  const sideLeverage = new Map<string, { att: number; def: number; mci: number; event: number; teamUid: string; oppUid: string; fixtureUid: string }>();

  for (const f of windowFx) {
    // B1 (v1.4.3, audit M1): the engine has computed win/draw/loss and full
    // concession grids since day one and never exposed them — publish the
    // preview into the insight reasons: probabilities + top scorelines
    // (independent Poisson over the blended lambdas, display-grade).
    const lh = Number(f.lambda_home_blend);
    const la = Number(f.lambda_away_blend);
    const pois = (l: number, k: number): number => (Math.exp(-l) * l ** k) / [1, 1, 2, 6, 24, 120, 720][k]!;
    const grid: { score: string; p: number }[] = [];
    for (let i = 0; i <= 5; i++) for (let j = 0; j <= 5; j++) grid.push({ score: `${i}-${j}`, p: pois(lh, i) * pois(la, j) });
    const topScorelines = grid.sort((a, b) => b.p - a.p).slice(0, 3).map((s) => ({ score: s.score, p: r2(s.p) }));
    const preview = {
      p_home: Number(f.p_home),
      p_draw: Number(f.p_draw),
      p_away: Number(f.p_away),
      top_scorelines: topScorelines,
      lambda_home: r2(lh),
      lambda_away: r2(la),
    };
    for (const side of ['home', 'away'] as const) {
      const teamUid = side === 'home' ? f.home_team_uid : f.away_team_uid;
      const oppUid = side === 'home' ? f.away_team_uid : f.home_team_uid;
      const att = Number(side === 'home' ? f.fdr_att_home : f.fdr_att_away);
      const def = Number(side === 'home' ? f.fdr_def_home : f.fdr_def_away);
      const teamPlayers = playersByTeam.get(teamUid) ?? [];
      const starDensity = teamPlayers.filter(
        (p) => Number(p.overall_score) >= topDecileScore && Number(p.p_start_xi) >= 0.6,
      ).length;
      const mci = 0.5 * att + 0.3 * def + 0.2 * Math.min(10, starDensity * 2.5);
      const volatility = volatileTeams.has(teamUid) || volatileTeams.has(oppUid);
      const reasons = {
        att_leverage: r2(att),
        def_leverage: r2(def),
        star_density: starDensity,
        dominant: att >= def ? 'attacking' : 'clean_sheet',
        volatility,
        preview,
      };
      insightRows.push({
        run_id: runId,
        fixture_uid: f.fixture_uid,
        event: f.event,
        side,
        att_leverage: att.toFixed(2),
        def_leverage: def.toFixed(2),
        mci: Math.min(10, mci).toFixed(2),
        star_density: starDensity,
        volatility,
        reasons: JSON.stringify(reasons),
      });
      sideLeverage.set(`${f.fixture_uid}|${teamUid}`, { att, def, mci, event: f.event, teamUid, oppUid, fixtureUid: f.fixture_uid });
      insightsCount++;
    }
  }
  for (let i = 0; i < insightRows.length; i += 500) {
    await db('match_insights').insert(insightRows.slice(i, i + 500)).onConflict(['run_id', 'fixture_uid', 'side']).merge();
  }

  // ── target lists
  let targetCount = 0;
  const targetRows: Record<string, unknown>[] = [];
  const nextEvent = events[0]!;

  // per high-leverage fixture-side: top-N by xpts_this_fixture · p_start
  const sortedSides = [...sideLeverage.values()].sort((a, b) => Math.max(b.att, b.def) - Math.max(a.att, a.def));
  const highLeverage = sortedSides.filter((s) => Math.max(s.att, s.def) >= 7).slice(0, 12);
  const globalCandidates = new Map<string, { score: number; reasons: Record<string, unknown>; event: number; fixtureUid: string }>();

  for (const s of highLeverage) {
    const fixturePfp = (pfpByFixture.get(s.fixtureUid) ?? []).filter((row) => {
      const meta = playerMeta.get(row.player_uid);
      return meta && meta.team_uid === s.teamUid;
    });
    const scoredPlayers = fixturePfp
      .map((row) => ({
        row,
        meta: playerMeta.get(row.player_uid)!,
        score: Number(row.xpts) * Number(row.p_start),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.target_list_size);
    let rank = 1;
    for (const t of scoredPlayers) {
      const reasons = {
        xpts: r2(Number(t.row.xpts)),
        p_start: r2(Number(t.row.p_start)),
        leverage: r2(Math.max(s.att, s.def)),
        kind: s.att >= s.def ? 'attacking_fixture' : 'clean_sheet_fixture',
      };
      targetRows.push({
        run_id: runId,
        event: s.event,
        scope: 'fixture',
        fixture_uid: s.fixtureUid,
        player_uid: t.row.player_uid,
        rank: rank++,
        score: t.score.toFixed(3),
        reasons: JSON.stringify(reasons),
      });
      targetCount++;
      const existing = globalCandidates.get(t.row.player_uid);
      if (!existing || existing.score < t.score) {
        globalCandidates.set(t.row.player_uid, { score: t.score, reasons, event: s.event, fixtureUid: s.fixtureUid });
      }
    }
  }

  // global per-GW list = union, deduped, re-ranked
  const globalSorted = [...globalCandidates.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 20);
  globalSorted.forEach(([uid, g], idx) => {
    targetRows.push({
      run_id: runId,
      event: g.event,
      scope: 'global',
      fixture_uid: g.fixtureUid,
      player_uid: uid,
      rank: idx + 1,
      score: g.score.toFixed(3),
      reasons: JSON.stringify(g.reasons),
    });
    targetCount++;
  });

  // differential variant: ownership < ⚙10%, ranked by xpts·p_start·(1−own%)
  const diffSorted = [...globalCandidates.entries()]
    .filter(([uid]) => Number(playerMeta.get(uid)?.selected_by_pct ?? 100) < cfg.differential_ownership_max)
    .map(([uid, g]) => ({ uid, g, score: g.score * (1 - Number(playerMeta.get(uid)!.selected_by_pct) / 100) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  diffSorted.forEach((d, idx) => {
    targetRows.push({
      run_id: runId,
      event: d.g.event,
      scope: 'differential',
      fixture_uid: d.g.fixtureUid,
      player_uid: d.uid,
      rank: idx + 1,
      score: d.score.toFixed(3),
      reasons: JSON.stringify({ ...d.g.reasons, ownership: Number(playerMeta.get(d.uid)!.selected_by_pct) }),
    });
    targetCount++;
  });

  // captaincy pool: top-N by 2·xpts_next1 with ceiling (xpts + 1.28σ)
  const nextEventXpts = new Map<string, { xpts: number; sigma: number }>();
  for (const row of pfp) {
    if (row.event !== nextEvent) continue;
    const cur = nextEventXpts.get(row.player_uid) ?? { xpts: 0, sigma: 0 };
    cur.xpts += Number(row.xpts);
    cur.sigma = Math.sqrt(cur.sigma ** 2 + Number(row.variance));
    nextEventXpts.set(row.player_uid, cur);
  }
  // ordered by SIMULATED P90 ceiling (the plan's §5.3.3 "captaincy ceiling").
  // A normal ±1.28σ approximation misprices captaincy: attacker points are
  // right-skewed (a 2-goal haul jumps 8+), a defender's clean-sheet day is
  // bounded. Small seeded simulation over the composer's own probabilities —
  // deterministic per run, ~40 players × 2000 draws.
  const nextEventRows = new Map<string, typeof pfp>();
  for (const row of pfp) {
    if (row.event !== nextEvent) continue;
    (nextEventRows.get(row.player_uid) ?? nextEventRows.set(row.player_uid, []).get(row.player_uid)!).push(row);
  }
  const metaByUid = new Map(matrix.map((m) => [m.player_uid, m]));
  const rng = mulberry32((runId * 2654435761) >>> 0);
  const captaincy = [...nextEventXpts.entries()]
    .sort((a, b) => b[1].xpts - a[1].xpts)
    .slice(0, 40) // preselect by mean; the sim decides the order
    .map(([uid, v]) => ({
      uid,
      doubled: 2 * v.xpts,
      ceiling: 2 * simulateP90(nextEventRows.get(uid) ?? [], metaByUid.get(uid)?.position ?? 'MID', scoring, rng),
    }))
    .sort((a, b) => b.ceiling - a.ceiling || b.doubled - a.doubled)
    .slice(0, cfg.captaincy_pool_size);
  captaincy.forEach((c, idx) => {
    targetRows.push({
      run_id: runId,
      event: nextEvent,
      scope: 'captaincy',
      fixture_uid: null,
      player_uid: c.uid,
      rank: idx + 1,
      // B5 (v1.4.2): the pool is ORDERED by ceiling, so the ceiling is the
      // displayed score — storing the doubled mean made rank 1 show a lower
      // number than rank 2 (audit M3, live-verified)
      score: c.ceiling.toFixed(3),
      reasons: JSON.stringify({ doubled_xpts: r2(c.doubled), ceiling: r2(c.ceiling), label: idx === 0 ? 'top_pick' : c.doubled > (captaincy[0]?.doubled ?? 0) ? 'safe_pick' : 'alternative' }),
    });
    targetCount++;
  });

  for (let i = 0; i < targetRows.length; i += 500) {
    await db('target_lists').insert(targetRows.slice(i, i + 500));
  }

  // ── A7 (v1.4.5): distribution quantiles for EVERY player's next event —
  // the same seeded Monte Carlo the captaincy pool uses, published to the
  // matrix as P10/P50/P90 (floors and ceilings, not just a mean)
  {
    const qBatch: { uid: string; q: SimQuantiles }[] = [];
    for (const m of matrix) {
      const rows = nextEventRows.get(m.player_uid);
      if (!rows || rows.length === 0) continue;
      qBatch.push({ uid: m.player_uid, q: simulateQuantiles(rows, m.position ?? 'MID', scoring, rng) });
    }
    for (let i = 0; i < qBatch.length; i += 200) {
      const chunk = qBatch.slice(i, i + 200);
      const values = chunk.map(() => '(?, ?::numeric, ?::numeric, ?::numeric)').join(', ');
      const params = chunk.flatMap((x) => [x.uid, x.q.p10, x.q.p50, x.q.p90]);
      await db.raw(
        `UPDATE player_matrix pm SET p10 = v.p10, p50 = v.p50, p90 = v.p90
         FROM (VALUES ${values}) AS v(player_uid, p10, p50, p90)
         WHERE pm.run_id = ${Number(runId)} AND pm.player_uid = v.player_uid`,
        params,
      );
    }
  }

  // ── B2 (v1.4.4): predicted XI per next-event fixture from OUR OWN minutes
  // model (pfp p_start), formation-valid (1 GK, ≥3 DEF, ≥2 MID, ≥1 FWD).
  // Confirmed sheets (api-football, KO window) overwrite nothing here — they
  // live under kind='confirmed' and outrank these downstream.
  const MINS: [string, number][] = [['GK', 1], ['DEF', 3], ['MID', 2], ['FWD', 1]];
  for (const f of windowFx.filter((x) => x.event === nextEvent)) {
    for (const side of ['home', 'away'] as const) {
      const teamUid = side === 'home' ? f.home_team_uid : f.away_team_uid;
      const rows = (pfpByFixture.get(f.fixture_uid) ?? [])
        .filter((r) => playerMeta.get(r.player_uid)?.team_uid === teamUid)
        .map((r) => ({ uid: r.player_uid, position: playerMeta.get(r.player_uid)!.position as string, pStart: Number(r.p_start) }))
        .sort((a, b) => b.pStart - a.pStart);
      if (rows.length < 11) continue;
      const picked: typeof rows = [];
      const taken = new Set<string>();
      for (const [pos, min] of MINS) {
        for (const r of rows.filter((x) => x.position === pos).slice(0, min)) {
          picked.push(r);
          taken.add(r.uid);
        }
      }
      for (const r of rows) {
        if (picked.length >= 11) break;
        if (taken.has(r.uid)) continue;
        if (r.position === 'GK') continue; // exactly one keeper
        picked.push(r);
        taken.add(r.uid);
      }
      if (picked.length < 11) continue;
      const bench = rows.filter((r) => !taken.has(r.uid)).slice(0, 7);
      const count = (pos: string): number => picked.filter((p) => p.position === pos).length;
      await db.raw(
        `INSERT INTO lineups (fixture_uid, team_uid, kind, formation, starters, bench, as_of)
         VALUES (?, ?, 'predicted', ?, ?, ?, now())
         ON CONFLICT (fixture_uid, team_uid, kind) DO UPDATE
           SET formation = excluded.formation, starters = excluded.starters,
               bench = excluded.bench, as_of = now()`,
        [f.fixture_uid, teamUid, `${count('DEF')}-${count('MID')}-${count('FWD')}`, JSON.stringify(picked.map((p) => p.uid)), JSON.stringify(bench.map((p) => p.uid))],
      );
    }
  }

  // ── DGW/BGW detection over the projection window (pure counting)
  const allFixtures = await db('fixtures')
    .whereIn('event', events.slice(0, cfg.dgw_projection_events))
    .select('event', 'home_team_uid', 'away_team_uid');
  const fixtureCounts = new Map<string, number>(); // `${event}|${team}`
  for (const f of allFixtures) {
    for (const t of [f.home_team_uid, f.away_team_uid]) {
      const key = `${f.event}|${t}`;
      fixtureCounts.set(key, (fixtureCounts.get(key) ?? 0) + 1);
    }
  }
  const teams = [...playersByTeam.keys()];
  const dgwByEvent = new Map<number, string[]>();
  const bgwByEvent = new Map<number, string[]>();
  for (const ev of events.slice(0, cfg.dgw_projection_events)) {
    for (const t of teams) {
      const n = fixtureCounts.get(`${ev}|${t}`) ?? 0;
      if (n >= 2) (dgwByEvent.get(ev) ?? dgwByEvent.set(ev, []).get(ev)!).push(t);
      if (n === 0) (bgwByEvent.get(ev) ?? bgwByEvent.set(ev, []).get(ev)!).push(t);
    }
  }

  // ── per-team chip-window scoring + coverage for every saved team
  const userTeams = await db('user_teams').select('id', 'user_id', 'bank', 'chips_used');
  const teamPlayers = await db('user_team_players').select('team_id', 'player_uid');
  const playersByUserTeam = new Map<number, string[]>();
  for (const tp of teamPlayers) {
    (playersByUserTeam.get(tp.team_id) ?? playersByUserTeam.set(tp.team_id, []).get(tp.team_id)!).push(tp.player_uid);
  }

  // per-player xpts for one event (DGW-aware sum over the event's fixtures)
  const playerEventXpts = (uid: string, ev: number): number => {
    let x = 0;
    for (const row of pfpByPlayer.get(uid) ?? []) if (row.event === ev) x += Number(row.xpts);
    return x;
  };
  const xptsForEvent = (uids: string[], ev: number): number => uids.reduce((s, uid) => s + playerEventXpts(uid, ev), 0);

  // B6/M9 (v1.4.5): every chip baseline is the XI the manager ACTUALLY
  // fields — best formation-valid XI with the best captain doubled — not an
  // undoubled 15-man sum vs an undoubled top-11 proxy
  const squadRules = await getConfig<SquadRules>(db, 'squad_rules').catch(() => null);
  const xiWithCaptain = (uids: string[], ev: number): number => {
    const players = uids.map((uid) => ({
      uid,
      position: (playerMeta.get(uid)?.position as string) ?? 'MID',
      club: '',
      price: 0,
      xpts: playerEventXpts(uid, ev),
    }));
    if (squadRules && players.length === 15) {
      try {
        return pickStartingXi(players, squadRules).xptsTotal; // captain doubled
      } catch {
        /* invalid squad shape — fall through to the proxy */
      }
    }
    const sorted = players.map((p) => p.xpts).sort((a, b) => b - a);
    const top11 = sorted.slice(0, 11);
    return top11.reduce((a, b) => a + b, 0) + (top11[0] ?? 0);
  };

  // benchmark: best-11 league-wide + best captain doubled (FH/WC ceiling)
  const bestXptsPerEvent = new Map<number, number>();
  for (const ev of events) {
    const perPlayer = new Map<string, number>();
    for (const row of pfp) {
      if (row.event !== ev) continue;
      perPlayer.set(row.player_uid, (perPlayer.get(row.player_uid) ?? 0) + Number(row.xpts));
    }
    const top11 = [...perPlayer.values()].sort((a, b) => b - a).slice(0, 11);
    bestXptsPerEvent.set(ev, top11.reduce((a, b) => a + b, 0) + (top11[0] ?? 0));
  }

  let chipCount = 0;
  let coverageCount = 0;

  for (const team of userTeams) {
    const uids = playersByUserTeam.get(team.id) ?? [];
    if (uids.length === 0) continue;

    // coverage: exposure to top-quartile leverage fixture-sides in the window
    const coverageWindow = events.slice(0, cfg.coverage_window_events);
    const windowSides = [...sideLeverage.values()].filter((s) => coverageWindow.includes(s.event));
    const leverageThreshold = quantile(windowSides.map((s) => Math.max(s.att, s.def)), 0.75);
    const gaps: Record<string, unknown>[] = [];
    let coverage = 0;
    for (const s of windowSides) {
      if (Math.max(s.att, s.def) < leverageThreshold) continue;
      const isAttacking = s.att >= s.def;
      const exposure = uids.filter((uid) => {
        const meta = playerMeta.get(uid);
        if (!meta || meta.team_uid !== s.teamUid) return false;
        if (Number(meta.p_start_xi) < 0.5) return false;
        return isAttacking ? ['MID', 'FWD'].includes(meta.position) : ['GK', 'DEF'].includes(meta.position);
      }).length;
      coverage += exposure;
      if (exposure === 0) {
        gaps.push({
          event: s.event,
          fixture_uid: s.fixtureUid,
          team_uid: s.teamUid,
          kind: isAttacking ? 'attacking' : 'clean_sheet',
          leverage: r2(Math.max(s.att, s.def)),
        });
      }
    }
    await db('coverage_reports')
      .insert({
        run_id: runId,
        team_id: team.id,
        window_events: cfg.coverage_window_events,
        coverage_score: coverage.toFixed(2),
        gaps: JSON.stringify(gaps),
      })
      .onConflict(['run_id', 'team_id'])
      .merge();
    coverageCount++;

    // chip-window scoring under set expiry
    const chipsUsed = new Set<string>((team.chips_used ?? []).map((c: { chip: string; set: number }) => `${c.chip}:${c.set}`));
    const chipRows: Record<string, unknown>[] = [];
    for (const set of chipRules.sets) {
      const setEvents = events.filter((ev) => ev >= set.start_event && ev <= set.stop_event);
      if (setEvents.length === 0) continue;
      for (const chip of set.chips) {
        if (chipsUsed.has(`${chip}:${set.set}`)) continue;
        let best: { event: number; value: number } | null = null;
        for (const ev of setEvents) {
          let value = 0;
          if (chip === 'freehit') {
            // M9: both sides now field a captained XI
            value = (bestXptsPerEvent.get(ev) ?? 0) - xiWithCaptain(uids, ev);
          } else if (chip === 'wildcard') {
            const horizon = setEvents.filter((e) => e >= ev).slice(0, cfg.wc_horizon_events);
            const realisation = cfg.wc_realisation ?? 0.35; // ⚙ (M5)
            for (const e of horizon) value += ((bestXptsPerEvent.get(e) ?? 0) - xiWithCaptain(uids, e)) * realisation;
          } else if (chip === 'bboost') {
            // M4: the REAL bench — the XI complement under the picked
            // formation — not the 4 weakest squad members
            if (squadRules && uids.length === 15) {
              const players = uids.map((uid) => ({
                uid,
                position: (playerMeta.get(uid)?.position as string) ?? 'MID',
                club: '',
                price: 0,
                xpts: playerEventXpts(uid, ev),
              }));
              try {
                const xi = pickStartingXi(players, squadRules);
                const starterSet = new Set(xi.starters.map((p) => p.uid));
                value = players.filter((p) => !starterSet.has(p.uid)).reduce((s, p) => s + p.xpts, 0);
              } catch {
                value = 0;
              }
            } else {
              const perPlayer = uids.map((uid) => playerEventXpts(uid, ev)).sort((a, b) => a - b);
              value = perPlayer.slice(0, 4).reduce((s, x) => s + x, 0);
            }
          } else if (chip === '3xc') {
            const perPlayer = uids.map((uid) => playerEventXpts(uid, ev));
            value = Math.max(0, ...perPlayer); // extra captain multiplier value
          }
          const dgwBonus = (dgwByEvent.get(ev) ?? []).filter((t) => uids.some((uid) => playerMeta.get(uid)?.team_uid === t)).length;
          value += chip === 'bboost' || chip === '3xc' ? dgwBonus * 1.5 : 0;
          if (!best || value > best.value) best = { event: ev, value };
        }
        if (!best) continue;
        // urgency: unused set chips approaching expiry
        const eventsLeft = set.stop_event - (events[0] ?? set.start_event);
        const urgency = eventsLeft <= cfg.chip_urgency_events ? cfg.chip_urgency_events - eventsLeft + 1 : 0;
        const caveats: string[] = [];
        const volatileEvent = windowFx.some((f) => f.event === best.event && (volatileTeams.has(f.home_team_uid) || volatileTeams.has(f.away_team_uid)));
        if (volatileEvent) caveats.push('fixtures in this event may still move (unscheduled matches)');
        if ((bgwByEvent.get(best.event) ?? []).length > 0 && chip === 'freehit') caveats.push('blank gameweek detected — strong Free Hit signal');
        chipRows.push({
          run_id: runId,
          team_id: team.id,
          chip,
          chip_set: set.set,
          event: best.event,
          value: best.value.toFixed(3),
          urgency,
          caveats: JSON.stringify(caveats),
        });
        chipCount++;
      }
    }
    if (chipRows.length > 0) await db('chip_recommendations').insert(chipRows);
  }

  log.info({ runId, insights: insightsCount, targets: targetCount, chips: chipCount }, 'match engine complete');
  return { insights: insightsCount, targets: targetCount, chipRecs: chipCount, coverageReports: coverageCount };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx]!;
}

function r2(x: number): number {
  return Number(x.toFixed(2));
}

/** Deterministic PRNG — engine outputs must be reproducible per run_id. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poissonDraw(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit && k < 12);
  return k - 1;
}

/**
 * Simulated 90th-percentile single-event points from the composer's own
 * per-fixture probabilities. Bonus is tied to the simulated performance
 * (hauls carry bonus), not to the mean — that is the whole point of a
 * ceiling. ⚙ draws=2000.
 */
export interface SimQuantiles {
  p10: number;
  p50: number;
  p90: number;
}

export function simulateQuantiles(
  rows: { p60: string | number; p_any: string | number; e_goals: string | number; e_assists: string | number; p_cs: string | number; p_defcon: string | number; e_saves: string | number; e_bonus: string | number }[],
  position: string,
  scoring: { goal: Record<string, number>; clean_sheet: Record<string, number>; assist: number; saves_per_point?: number },
  rng: () => number,
): SimQuantiles {
  if (rows.length === 0) return { p10: 0, p50: 0, p90: 0 };
  const goalPts = scoring.goal[position] ?? 5;
  const csPts = scoring.clean_sheet[position] ?? 0;
  // M7 (v1.4.5): save points come from the rules, never a `/3` literal
  const savesPerPoint = scoring.saves_per_point ?? 3;
  const draws = 2000;
  const totals: number[] = new Array(draws);
  for (let i = 0; i < draws; i++) {
    let pts = 0;
    for (const row of rows) {
      const p60 = Number(row.p60);
      const pAny = Number(row.p_any);
      const appearanceRoll = rng();
      const played60 = appearanceRoll < p60;
      const playedAny = appearanceRoll < pAny;
      if (!playedAny) continue;
      pts += played60 ? 2 : 1;
      const goals = poissonDraw(rng, Number(row.e_goals));
      const assists = poissonDraw(rng, Number(row.e_assists));
      pts += goals * goalPts + assists * scoring.assist;
      if (played60 && rng() < Number(row.p_cs)) pts += csPts;
      if (played60 && rng() < Number(row.p_defcon)) pts += 2;
      if (position === 'GK') pts += Math.floor(poissonDraw(rng, Number(row.e_saves)) / savesPerPoint);
      // bonus rides the performance: hauls take 3; otherwise the draw comes
      // from the ⚙ bonus model's OWN e_bonus so E[sim bonus] ≈ e_bonus (M7)
      const returns = goals + assists;
      if (returns >= 2) pts += 3;
      else if (returns === 1) pts += rng() < 0.55 ? 2 : 1;
      else {
        const eb = Math.min(1.3, Number(row.e_bonus));
        const r = rng();
        if (r < eb / 4) pts += 2;
        else if (r < (eb / 4) * 3) pts += 1;
      }
    }
    totals[i] = pts;
  }
  totals.sort((a, b) => a - b);
  return {
    p10: totals[Math.floor(0.1 * draws)]!,
    p50: totals[Math.floor(0.5 * draws)]!,
    p90: totals[Math.floor(0.9 * draws)]!,
  };
}

export function simulateP90(
  rows: { p60: string | number; p_any: string | number; e_goals: string | number; e_assists: string | number; p_cs: string | number; p_defcon: string | number; e_saves: string | number; e_bonus: string | number }[],
  position: string,
  scoring: { goal: Record<string, number>; clean_sheet: Record<string, number>; assist: number; saves_per_point?: number },
  rng: () => number,
): number {
  return simulateQuantiles(rows, position, scoring, rng).p90;
}
