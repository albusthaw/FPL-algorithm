/** API client — same-origin fetch with the CSRF header on every mutation. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Requested-With': 'fpl-frontend',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message, json);
  }
  return json as T;
}

export const api = {
  get: <T>(url: string): Promise<T> => request<T>('GET', url),
  post: <T>(url: string, body?: unknown): Promise<T> => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown): Promise<T> => request<T>('PUT', url, body),
  patch: <T>(url: string, body?: unknown): Promise<T> => request<T>('PATCH', url, body),
  del: <T>(url: string): Promise<T> => request<T>('DELETE', url),
  upload: async <T>(url: string, file: File): Promise<T> => {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Requested-With': 'fpl-frontend' },
      body: form,
      credentials: 'same-origin',
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`, json);
    return json as T;
  },
};

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'user' | 'admin';
  tokenBalance: number;
}

export interface MatrixPlayer {
  uid: string;
  web_name: string;
  full_name?: string;
  position: string;
  club: string | null;
  price: number;
  selected_by_pct?: string;
  stat_score?: string;
  ai_adjustment?: string;
  ai_stale?: boolean;
  overall_score?: string;
  rank_overall?: number;
  rank_position?: number;
  xpts_next1?: string;
  xpts_next3?: string;
  xpts_next6?: string;
  p_start_xi?: string;
  injury_status?: string;
  form_ewma?: string;
  fdr_next3?: string;
  ai_rationale?: string;
  // A6 (v1.4.3): FPL's own benchmark + ICT — display columns
  ep_next?: string | null;
  ict_index?: string | null;
}

export const fmtPrice = (tenths: number): string => `£${(tenths / 10).toFixed(1)}m`;
export const n = (v: string | number | null | undefined, dp = 1): string => {
  if (v == null) return '—';
  const num = Number(v);
  return Number.isFinite(num) ? num.toFixed(dp) : '—';
};

/** Percentage display that never shows NaN — non-finite renders as a dash. */
export const pct = (v: string | number | null | undefined): string => {
  if (v == null) return '—';
  const num = Number(v);
  return Number.isFinite(num) ? `${Math.round(num * 100)}%` : '—';
};
