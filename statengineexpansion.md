# Statistical Engine Expansion — closing the gap to market-grade projections

**Document status:** Authoritative expansion plan for the statistical engine
(v1.3.0). Companion to `fpl-engines-plan.md` (which it refines, not replaces)
and `fpl-project.md` §5. Written from LIVE evidence on a fully-ingested
install (2026-08-21, real provider keys) and executed in the same release.

---

## Part 0 — The evidence (why the initial XI looked wrong)

The optimiser was blamed for picking a £6.0 unknown (Osula) as the lone
striker. The optimiser was innocent: it maximises Σ expected points under
the budget, and the model handed it these numbers (run 17, live data):

| Player | Price | our xPts next-1 | our xPts next-6 | market next-1 | market next-6 |
|---|---|---|---|---|---|
| Haaland | £15.5 | **4.59** | **23.3** | 6.6–6.8 | ~37.9 |
| Osula | £6.0 | 3.74 | 20.2 | ~3 | ~18 |

Our Haaland is priced £9.5 above Osula but projected only **+3.1 points
over six gameweeks** — so any rational optimiser buys five mid-price
defenders instead. Market-grade models separate them by ~20 points. The
model compresses the top of the distribution; everything downstream
(initial XI, captaincy, transfer suggestions, rankings) inherits the
compression. Reference points: [FPL Review's model docs](https://docs.fplreview.com/the-model/projections/massive-data-model/),
[FPL Copilot's xPts methodology](https://fplcopilot.com/blog/expected-points-explained),
[Fantasy Football Fix GW1 projections](https://www.fantasyfootballfix.com/blog-index/best-fpl-forwards-gameweek-1/),
[KnightManagers GW1 captaincy projections](https://knightmanagers.com/theplaybook/fpl-captain-gw1-2026-27/).
Common to all of them: minutes realism, **penalty/set-piece roles**,
opponent adjustment, and bonus patterns tied to returns.

### Root causes, each verified against live data

- **R1 — Minutes.** Haaland's expected minutes came out at ~66. His
  minutes EWMA (60.3) is dragged down by late-season rests and cameo
  rows; the per-position `E[min|start]` table then CAPS a 90-minute
  striker at 78. Compresses every premium by 10–25%.
- **R2 — Penalties are stored but never scored.** `set_piece_roles` holds
  132 rows (Haaland pens_order=1) and the engines plan §4.5 specifies the
  penalty term — the composer never used it. Worth ~+0.5–1.0 pts/GW to
  first-choice takers, exactly the premium class.
- **R3 — Bonus is flat.** Profile means give Haaland E[bonus] 0.56/GW;
  bonus follows returns (a brace is almost always 3). Premiums with high
  E[goal involvement] should project ~1.0+.
- **R4 — Rate shrinkage + decay double-penalty.** Raw xG90 0.78 (25.5 xG
  in 2,953 min) lands at 0.64 after shrinkage-to-prior plus in-season
  decay. For a 33-effective-match sample that is too much pull.
- **R5 — xA → FPL-assist conversion never applied.** FPL assists are
  broader than Opta xA (won penalties, deflected passes, FK wins);
  the plan's ⚙assist_conv (~1.08) was documented, not implemented.
- **R6 — No odds temper (structural, not fixed here).** With no odds
  provider enabled, Dixon-Coles runs unblended and clean-sheet tails run
  hot (61% home CS). The odds blend (L2) already handles this the moment
  an odds-capable provider (API-Football Pro) is enabled. Noted, config
  unchanged.

---

## Part 1 — Expansion packages (all executed in this release)

Every constant marked ⚙ lives in `model_config` (new keys seed on upgrade
via `ON CONFLICT DO NOTHING`; existing installs pick them up on migrate).

### X1 — Minutes realism (L0 + L3)
- New L0 feature `startedMinutesAvg`: decay-weighted mean of minutes in
  STARTED matches only, shrunk (⚙ k=4) toward the position table. Rests
  and sub cameos no longer poison a nailed starter's expected minutes.
- `E[min|start]` uses `startedMinutesAvg` where history exists; the
  position table becomes the prior, not the cap. ⚙ caps raised:
  GK 90, DEF 89, MID 86, FWD 86.
- Start-share table top row ⚙ 0.95 (a 37-start player is not an 0.93).

### X2 — Set-piece & penalty expected value (L4, plan §4.5 delivered)
For pens_order = 1 (and 2 at reduced share):
```
E[pen_goals] = ⚙team_pens_per_match(0.28) · attRatio · taker_share(⚙0.85 / 0.10)
             · ⚙pen_conversion(0.76)
xg90_np      = xg90 − ⚙pen_xg_deduction(0.06)   # avoid double-count for order-1
```
Corners/direct-FK first takers get ⚙ +0.04 xa90 (dead-ball assist stream).
All from `set_piece_roles` (FPL bootstrap truth, admin-overridable).

### X3 — Bonus steepening (L7)
Bonus rides returns, not averages:
```
FWD/MID: E[bonus] = clamp(⚙0.10 + ⚙1.15·E[goals+assists], 0, 2.5)
DEF:     E[bonus] = clamp(⚙0.12 + ⚙1.05·E[goals+assists] + ⚙0.9·p_cs·(0.4+p_defcon), 0, 2.5)
GK:      E[bonus] = clamp(⚙0.08 + ⚙0.8·p_cs·min(1, saves90/3.5), 0, 2.0)
```
Constants chosen to reproduce observed bonus/return curves (a returning
premium ≈ 1.2–1.5, a blanking defender in a CS ≈ 0.5); refit each season.

### X4 — Shrinkage & decay sanity (L0)
- In-season rate decay ⚙ ξ 0.01 → 0.005 (half-life ~140 football-days):
  a title-season sample should not lose a fifth of its weight by May.
- Shrinkage k stays 6 — the fix above removes the double penalty; k alone
  now pulls a 33-match premium ~8%, which is healthy regression.
- ⚙assist_conv 1.08 applied in the composer (R5).

### X5 — Human-factors layer (new, bounded, all ⚙ `human_factors`)
The parts of the game stats cannot see, encoded as bounded terms — the AI
pass stays the free-text channel; these are the structured ones:
- **Crowd wisdom (ownership momentum):** stat_score gains ⚙ w7=0.04 ·
  z(net transfers in). Ten million managers moving toward a player is
  information; bounded so it can never dominate the model.
- **Suspension tightrope:** ⚙4+ yellows before the GW19 amnesty → the
  3/6-GW horizons take a ⚙ 0.96/0.93 haircut (one booking from a ban).
- **Trust floor (undroppables):** heavily-owned, fully-fit players keep
  their p_start floor even in rotation noise (shipped in v1.1.0, now
  documented as part of this layer).
- **Adaptation & fatigue:** new-signing (×⚙0.70) and congestion (×⚙0.85)
  multipliers (shipped earlier) belong to this layer.
- **Role security via set pieces:** X2 doubles as a human factor — a
  manager handing a player the penalties is a statement of trust.
- Deliberately NOT included: weather, referee bias, "vibes" — either no
  reliable feed or the AI pass covers them qualitatively.

### X6 — Data-coverage audit (the "is everyone really updated?" answer)
New admin endpoint `GET /api/admin/data-coverage`:
per-player — history matches, minutes, xG rows present, news items (7d),
identity providers, set-piece row, latest-run matrix presence; plus a
summary (players with zero history, % matrix coverage, stale news). Admin
UI gains a **Data coverage** tab rendering it with the striped-table style.
Acceptance: matrix coverage = 100% of active players on every run.

### X7 — Price-continuous attacking prior (L0) — added during gate verification
The first verification run exposed residual compression: every FWD's shrunk
xg90 crowded ~0.5 (Osula 0.488 vs Haaland 0.672) because the shrinkage
target was a position(×coarse band) mean. FPL price IS the market's
published expected-returns prior, so attacking rates now shrink toward
`rate_at_ref × clamp((price/ref)^elasticity, mult_range)` (⚙ `price_prior`).
Volume stats (saves, CBIT/CBIRT, cards) keep the band priors. A second ⚙
(`feature_factory.shrinkage_k_attacking = 10`) reflects that xG/xA rates
stabilise slower than volume stats.

### X8 — Horizon start-probability target from long-run share (L0 + L3)
The old horizon regression dragged EVERY starter toward the positional base
(0.45 for FWD) by fixture 6 — a 34-starts-of-38 premium and an
8-starts-of-38 cameo player converged. New L0 feature `startShareLong`
(undecayed starts/matches over the window); the horizon target becomes
`max(positional_base, startShareLong × horizon_target_mult)` (⚙ in
`minutes_realism`). Haaland keeps ~0.86 six fixtures out; Osula still
regresses to 0.45.

### X9 — Penalty double-count kill + optimiser truthfulness (found in verification)
- `pen_xg_deduction` was 0.06 while the explicit pen-EV term re-adds ≈0.18
  per match for order-1 takers: incumbent takers' penalties were counted
  nearly twice. The deduction now equals what the term re-adds (0.181), and
  when non-penalty xG (`npxg`) exists in match rows the composer uses the
  shrunk `npxg90` rate directly — exact, no estimate.
- The ILP squad model declared binary picks under `ints`, which
  javascript-lp-solver treats as UNBOUNDED integers — the solver "filled"
  the squad by taking cheap players twice, silently failing into the greedy
  fallback (whose 1-swaps cannot escape the balanced-squad local optimum).
  Fixed with `binaries`, a 1% MIP gap + 5s time limit.
- The optimiser objective now includes captain doubling (Σcap ≤ 1 linked
  binaries over the top-10 xpts candidates): the game really does double
  one player every week, which is precisely what premium concentration buys.

---

## Part 2 — Acceptance gates (all must pass before the release ships)

| # | Gate | Result (run 21, v1.3.0) |
|---|------|-------------------------|
| 1 | Haaland next-1 ∈ [5.5, 8.0]; next-6 ≥ 30 (market 6.6–6.8 / 37.9) | **6.80 / 37.07 ✓** |
| 2 | Top-1 vs top-10 FWD spread over 6 GWs ≥ 12 (was 8.5) | **17.0 ✓** |
| 3 | £6.0 rotation striker (Osula) ≤ 60% of Haaland over 6 GWs (was 87%) | **54.2% ✓** |
| 4 | Optimiser squad contains Haaland + ≥2 £9.0+ players, no £6.0 lone striker | **✓ (ILP: Haaland, Palmer; front line Haaland/Thiago/Calvert-Lewin)** |
| 5 | Captaincy #1 premium attacker (P90 sim) | **✓ B.Fernandes #1, Haaland #2** |
| 6 | Composer property tests reproduce FPL arithmetic exactly | **✓ 95/95 backend tests** |
| 7 | Full backend suite + Playwright + upgrade rehearsal green | **✓** |
| — | Data coverage: every active player in the latest run | **✓ 600/600** |

## Part 3 — Execution order

1. model_config: new ⚙ keys (`minutes_model` caps, `set_piece_ev`,
   `bonus_model`, `human_factors`, feature-factory decay) — seeds on
   upgrade automatically.
2. L0 `startedMinutesAvg` + decay change; L3 eMin from it; table top 0.95.
3. Composer: pen EV, xa bump, assist_conv, new bonus model (all inputs
   threaded from engine.ts, set_piece_roles loaded once per run).
4. engine.ts: suspension-tightrope haircut, w7 ownership-momentum term.
5. Admin data-coverage endpoint + UI tab.
6. Unit tests per package; live verification run against the gates;
   version bump → rebuild i.zip → rehearse → ship.

*End of expansion plan. Executed in v1.3.0.*
