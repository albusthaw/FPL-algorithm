/**
 * A2 (v1.4.4) — price-change intelligence. The price_events writer has
 * recorded every actual move since v1.0; this module adds the model:
 * FPL price changes fire when net transfers cross an OWNERSHIP-SCALED
 * threshold (a 40%-owned player needs far more movement than a 2% punt).
 *
 *   θ(player) = θ_base × max(ownership%, floor)^power
 *   p = clamp(|net| / θ)
 *
 * Nightly predictions land in price_predictions (keyed player+date) and the
 * model SELF-CALIBRATES: each morning the previous calls are scored against
 * actual price_events and ⚙ price_model.theta_base is nudged as a NEW
 * config version — data refit, never a code change.
 */
import type { Knex } from 'knex';
import { getConfig, setConfig } from '../core/model-config.js';
import { log } from '../core/logger.js';

export interface PriceModelConfig {
  theta_base: number; // net transfers to move a 10%-owned player
  ownership_power: number;
  ownership_floor: number; // % — tiny ownerships don't shrink θ to zero
  predict_min_p: number; // publish rise/fall only at/above this confidence
  calibrate_step: number; // multiplicative nudge per calibration pass
  calibrate_min_events: number;
}

export const DEFAULT_PRICE_MODEL: PriceModelConfig = {
  theta_base: 90000,
  ownership_power: 0.45,
  ownership_floor: 0.5,
  predict_min_p: 0.6,
  calibrate_step: 0.1,
  calibrate_min_events: 5,
};

export function thresholdFor(cfg: PriceModelConfig, ownershipPct: number): number {
  const own = Math.max(cfg.ownership_floor, ownershipPct);
  return cfg.theta_base * Math.pow(own / 10, cfg.ownership_power);
}

export function predictOne(
  cfg: PriceModelConfig,
  net: number,
  ownershipPct: number,
): { direction: 'rise' | 'fall' | 'hold'; p: number; threshold: number } {
  const threshold = thresholdFor(cfg, ownershipPct);
  const p = Math.min(0.99, Math.abs(net) / threshold);
  if (p < cfg.predict_min_p) return { direction: 'hold', p: Number(p.toFixed(3)), threshold };
  return { direction: net > 0 ? 'rise' : 'fall', p: Number(p.toFixed(3)), threshold };
}

/** Nightly pass: score every owned player, store tonight's calls. */
export async function predictPriceMoves(db: Knex, forDate?: string): Promise<{ rises: number; falls: number; scored: number }> {
  const cfg = { ...DEFAULT_PRICE_MODEL, ...((await getConfig<Partial<PriceModelConfig>>(db, 'price_model').catch(() => null)) ?? {}) };
  // predictions are FOR the coming change window (~01:30–02:30 UTC tomorrow)
  const target = forDate ?? new Date(Date.now() + 12 * 3600_000).toISOString().slice(0, 10);
  const players = (await db('players')
    .whereNotNull('team_uid')
    .select('uid', 'selected_by_percent', 'transfers_in_event', 'transfers_out_event')) as {
    uid: string;
    selected_by_percent: string;
    transfers_in_event: number;
    transfers_out_event: number;
  }[];

  let rises = 0;
  let falls = 0;
  const batch: Record<string, unknown>[] = [];
  for (const p of players) {
    const net = p.transfers_in_event - p.transfers_out_event;
    const own = Number(p.selected_by_percent);
    const r = predictOne(cfg, net, own);
    if (r.direction === 'hold' && Math.abs(net) < r.threshold * 0.3) continue; // don't store obvious holds
    if (r.direction === 'rise') rises++;
    if (r.direction === 'fall') falls++;
    batch.push({
      player_uid: p.uid,
      for_date: target,
      direction: r.direction,
      p: r.p,
      net_transfers: net,
      threshold: r.threshold.toFixed(2),
      evidence: JSON.stringify({ ownership: own, theta_base: cfg.theta_base }),
    });
  }
  for (let i = 0; i < batch.length; i += 300) {
    await db('price_predictions')
      .insert(batch.slice(i, i + 300))
      .onConflict(['player_uid', 'for_date'])
      .merge(['direction', 'p', 'net_transfers', 'threshold', 'evidence']);
  }
  log.info({ scored: batch.length, rises, falls, target }, 'price prediction pass');
  return { rises, falls, scored: batch.length };
}

/**
 * Morning pass: score yesterday's calls against actual price_events and
 * nudge θ_base — too many false rises → θ up; high precision AND misses
 * (actual moves we called hold) → θ down. Writes a new config version.
 */
export async function calibratePriceModel(db: Knex): Promise<{ precision: number | null; recall: number | null; thetaBase: number } | null> {
  const cfg = { ...DEFAULT_PRICE_MODEL, ...((await getConfig<Partial<PriceModelConfig>>(db, 'price_model').catch(() => null)) ?? {}) };
  const today = new Date().toISOString().slice(0, 10);
  const preds = (await db('price_predictions').where('for_date', today).whereNot('direction', 'hold')) as {
    player_uid: string;
    direction: string;
  }[];
  const actual = (await db('price_events').where('event_date', today).select('player_uid', 'old_cost', 'new_cost')) as {
    player_uid: string;
    old_cost: number;
    new_cost: number;
  }[];
  if (preds.length < cfg.calibrate_min_events && actual.length < cfg.calibrate_min_events) return null;

  const actualDir = new Map(actual.map((a) => [a.player_uid, a.new_cost > a.old_cost ? 'rise' : 'fall']));
  const hits = preds.filter((p) => actualDir.get(p.player_uid) === p.direction).length;
  const precision = preds.length > 0 ? hits / preds.length : null;
  const recall = actual.length > 0 ? actual.filter((a) => preds.some((p) => p.player_uid === a.player_uid && p.direction === actualDir.get(a.player_uid))).length / actual.length : null;

  let theta = cfg.theta_base;
  if (precision != null && precision < 0.85 && preds.length >= cfg.calibrate_min_events) {
    theta = Math.round(theta * (1 + cfg.calibrate_step)); // over-calling → raise the bar
  } else if (recall != null && recall < 0.5 && (precision == null || precision >= 0.85) && actual.length >= cfg.calibrate_min_events) {
    theta = Math.round(theta * (1 - cfg.calibrate_step / 2)); // missing real moves → lower it gently
  }
  if (theta !== cfg.theta_base) {
    await setConfig(db, 'price_model', { ...cfg, theta_base: theta });
    log.info({ precision, recall, from: cfg.theta_base, to: theta }, 'price model recalibrated (new config version)');
  } else {
    log.info({ precision, recall, thetaBase: theta }, 'price model calibration: no change');
  }
  return { precision, recall, thetaBase: theta };
}
