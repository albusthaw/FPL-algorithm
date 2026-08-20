import type { Knex } from 'knex';

export class InsufficientTokensError extends Error {
  constructor(public balance: number, public required: number) {
    super(`insufficient tokens: balance ${balance}, required ${required}`);
    this.name = 'InsufficientTokensError';
  }
}

export type LedgerReason = 'topup' | 'run' | 'vision' | 'refund' | 'adjust';

/**
 * Atomic token debit/credit. Locks the user row (SELECT ... FOR UPDATE),
 * checks the balance for debits, writes the ledger row with balance_after.
 * Admins are never debited (unlimited), but usage is still recorded as a
 * zero-delta ledger row so cost visibility survives.
 */
export async function applyTokens(
  db: Knex,
  opts: {
    userId: number;
    delta: number; // negative = debit
    reason: LedgerReason;
    runId?: number | null;
    adminId?: number | null;
    note?: string;
  },
): Promise<{ balanceAfter: number }> {
  return db.transaction(async (trx) => {
    const user = await trx('users').where('id', opts.userId).forUpdate().first();
    if (!user) throw new Error(`user ${opts.userId} not found`);
    const isAdmin = user.role === 'admin';
    const effectiveDelta = isAdmin && opts.delta < 0 ? 0 : opts.delta;
    const balance = Number(user.token_balance);
    const balanceAfter = balance + effectiveDelta;
    if (balanceAfter < 0) throw new InsufficientTokensError(balance, -opts.delta);
    if (effectiveDelta !== 0) {
      await trx('users')
        .where('id', opts.userId)
        .update({ token_balance: balanceAfter, updated_at: trx.fn.now() });
    }
    await trx('token_ledger').insert({
      user_id: opts.userId,
      delta: effectiveDelta,
      balance_after: balanceAfter,
      reason: opts.reason,
      run_id: opts.runId ?? null,
      admin_id: opts.adminId ?? null,
      note: opts.note ?? (isAdmin && opts.delta < 0 ? `admin usage (uncharged): ${-opts.delta}` : null),
    });
    return { balanceAfter };
  });
}

export async function getBalance(db: Knex, userId: number): Promise<number> {
  const row = await db('users').where('id', userId).first('token_balance');
  return row ? Number(row.token_balance) : 0;
}
