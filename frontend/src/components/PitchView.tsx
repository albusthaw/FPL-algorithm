import type { ReactNode } from 'react';
import { fmtPrice } from '../api';

export interface PitchPlayer {
  uid: string;
  web_name: string;
  position: string;
  club?: string | null;
  price?: number;
  xpts?: number | string | null;
  isCaptain?: boolean;
  isVice?: boolean;
}

const SHIRT: Record<string, string> = { GK: '🧤', DEF: '🛡', MID: '⚙', FWD: '⚡' };

function Slot({ p, onClick }: { p: PitchPlayer; onClick?: (uid: string) => void }): ReactNode {
  return (
    <div
      className={`pitch-slot ${onClick ? 'clickable' : ''}`}
      onClick={onClick ? () => onClick(p.uid) : undefined}
      data-testid="pitch-slot"
    >
      {p.isCaptain && <span className="cap">C</span>}
      {p.isVice && !p.isCaptain && <span className="cap" style={{ opacity: 0.85 }}>V</span>}
      <div className="shirt">{SHIRT[p.position] ?? '·'}</div>
      <div className="nm">{p.web_name}</div>
      <div className="meta">
        {p.price != null && <span>{fmtPrice(p.price)}</span>}
        {p.xpts != null && <span>{Number(p.xpts).toFixed(1)}xP</span>}
      </div>
    </div>
  );
}

/**
 * FPL-style pitch: starters by position rows, bench strip below.
 * Reflows via percentage widths — no horizontal overflow at any width.
 */
export function PitchView({
  starters,
  bench,
  onSelect,
}: {
  starters: PitchPlayer[];
  bench: PitchPlayer[];
  onSelect?: (uid: string) => void;
}): ReactNode {
  const rows: PitchPlayer[][] = ['GK', 'DEF', 'MID', 'FWD'].map((pos) => starters.filter((p) => p.position === pos));
  return (
    <div>
      <div className="pitch">
        {rows.map(
          (row, i) =>
            row.length > 0 && (
              <div className="pitch-row" key={i}>
                {row.map((p) => (
                  <Slot key={p.uid} p={p} onClick={onSelect} />
                ))}
              </div>
            ),
        )}
        {bench.length > 0 && (
          <div className="pitch-bench">
            {bench.map((p) => (
              <Slot key={p.uid} p={p} onClick={onSelect} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
