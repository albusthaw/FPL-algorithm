/**
 * Unified error taxonomy (fpl-api-integration-plan.md §1.2). Every failure an
 * adapter can encounter maps to exactly one class; the gateway implements the
 * handling once.
 */
export type ErrorClass =
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'AUTH'
  | 'PLAN_DENIED'
  | 'NOT_FOUND'
  | 'SCHEMA_DRIFT'
  | 'MAINTENANCE'
  | 'EMPTY_OK';

export class PullError extends Error {
  constructor(
    public errorClass: ErrorClass,
    message: string,
    public detail?: unknown,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PullError';
  }
}

export function classifyHttpStatus(status: number, body?: string): ErrorClass {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401) return 'AUTH';
  if (status === 403) {
    const text = (body ?? '').toLowerCase();
    if (text.includes('plan') || text.includes('subscription') || text.includes('upgrade')) return 'PLAN_DENIED';
    return 'AUTH';
  }
  if (status === 402) return 'QUOTA_EXHAUSTED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 503 || status === 502) return 'MAINTENANCE';
  if (status >= 500) return 'NETWORK';
  return 'SCHEMA_DRIFT';
}
