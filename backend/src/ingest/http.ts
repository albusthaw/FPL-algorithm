import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { PullError, classifyHttpStatus, type ErrorClass } from './errors.js';
import { log } from '../core/logger.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface SnapshotResult {
  status: number;
  body: unknown;
  bodyText: string;
  sha256: string;
  unchanged: boolean;
  rawPayloadId: number;
  headers: Record<string, string>;
  latencyMs: number;
}

const RETRY_DELAYS_MS = [2000, 4000, 8000];

/**
 * Snapshot-first fetch (fpl-engines-plan.md §1.4): the raw body is persisted
 * to raw_payloads BEFORE any parsing, with SHA-256 delta detection against
 * the previous snapshot of the same (provider, endpoint, params_hash).
 * Retries ×3 with backoff on 5xx/network only — never on 4xx.
 */
export async function fetchWithSnapshot(
  db: Knex,
  opts: {
    provider: string;
    endpoint: string;
    url: string;
    headers?: Record<string, string>;
    paramsHash?: string;
    timeoutMs?: number;
    fetchFn?: FetchFn;
    retry?: boolean;
  },
): Promise<SnapshotResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const paramsHash = opts.paramsHash ?? crypto.createHash('sha256').update(opts.url).digest('hex').slice(0, 16);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxAttempts = opts.retry === false ? 1 : RETRY_DELAYS_MS.length + 1;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetchFn(opts.url, {
        headers: opts.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await sleep(jitter(RETRY_DELAYS_MS[attempt]!));
        continue;
      }
      throw new PullError('NETWORK', `network failure fetching ${opts.endpoint}: ${String(err)}`);
    }
    const latencyMs = Date.now() - started;
    const bodyText = await response.text();

    // 5xx → retry; everything else falls through to snapshot + classification
    if (response.status >= 500 && attempt < maxAttempts - 1) {
      lastErr = new PullError(classifyHttpStatus(response.status, bodyText), `HTTP ${response.status}`);
      await sleep(jitter(RETRY_DELAYS_MS[attempt]!));
      continue;
    }

    const sha256 = crypto.createHash('sha256').update(bodyText).digest('hex');
    const previous = await db('raw_payloads')
      .where({ provider: opts.provider, endpoint: opts.endpoint, params_hash: paramsHash })
      .orderBy('fetched_at', 'desc')
      .first('body_sha256');
    const unchanged = previous?.body_sha256 === sha256;

    let bodyJson: unknown = null;
    let isJson = false;
    try {
      bodyJson = JSON.parse(bodyText);
      isJson = true;
    } catch {
      isJson = false;
    }

    const [inserted] = await db('raw_payloads')
      .insert({
        provider: opts.provider,
        endpoint: opts.endpoint,
        params_hash: paramsHash,
        http_status: response.status,
        body: isJson && !unchanged ? JSON.stringify(bodyJson) : null,
        body_text: !isJson && !unchanged ? bodyText.slice(0, 500_000) : null,
        body_sha256: sha256,
        unchanged,
      })
      .returning('id');

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (response.status >= 400) {
      const errorClass = classifyHttpStatus(response.status, bodyText);
      const retryAfter = headers['retry-after'] ? Number(headers['retry-after']) * 1000 : undefined;
      throw new PullError(errorClass, `HTTP ${response.status} from ${opts.provider} ${opts.endpoint}`, bodyText.slice(0, 2000), retryAfter);
    }

    return {
      status: response.status,
      body: bodyJson,
      bodyText,
      sha256,
      unchanged,
      rawPayloadId: Number(inserted.id ?? inserted),
      headers,
      latencyMs,
    };
  }
  throw lastErr instanceof PullError
    ? lastErr
    : new PullError('NETWORK', `exhausted retries for ${opts.endpoint}: ${String(lastErr)}`);
}

export async function logPull(
  db: Knex,
  opts: {
    provider: string;
    capability: string;
    endpoint: string;
    params?: Record<string, unknown>;
    records?: number;
    latencyMs?: number;
    status: 'ok' | 'degraded' | 'failed' | 'empty_ok';
    errorClass?: ErrorClass;
    errorDetail?: string;
    quotaHeaders?: Record<string, string>;
  },
): Promise<void> {
  try {
    await db('api_pull_log').insert({
      provider: opts.provider,
      capability: opts.capability,
      endpoint: opts.endpoint,
      params: JSON.stringify(opts.params ?? {}),
      records: opts.records ?? 0,
      latency_ms: opts.latencyMs ?? 0,
      status: opts.status,
      error_class: opts.errorClass ?? null,
      error_detail: opts.errorDetail?.slice(0, 2000) ?? null,
      quota_headers: opts.quotaHeaders ? JSON.stringify(opts.quotaHeaders) : null,
    });
  } catch (err) {
    log.error({ err: String(err) }, 'failed to write api_pull_log');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * ms * 0.3);
}
