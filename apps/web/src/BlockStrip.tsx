/**
 * "Last blocks" strip: one thin column per block, split into the clear-signable
 * share (bottom, green) and the rest (top, red). The newest block is on the
 * right and gets a headline line above the strip. Hover shows the counts.
 *
 * The split follows the same toggles as the rest of the page: an excluded kind
 * of transaction is left out of the block's denominator.
 */

import { useState } from "react";
import type { BlockStat } from "./types.ts";
import { COLOR, fmtInt, fmtPct } from "./buckets.ts";

export interface BlockSplit {
  counted: number;
  signable: number;
  pct: number;
}

/** Split a block by the toggles: what is counted, and how much of it is clear-signable. */
export function splitBlock(b: BlockStat, countEth: boolean, countToken: boolean): BlockSplit {
  const counted = b.total - (countEth ? 0 : b.eth) - (countToken ? 0 : b.tokenStd);
  const signable = b.coveredOther + (countToken ? b.tokenStd : 0) + (countEth ? b.eth : 0);
  return { counted, signable, pct: counted > 0 ? (signable / counted) * 100 : 0 };
}

export function BlockStrip({
  blocks,
  countEth,
  countToken,
  onOpen,
}: {
  blocks: BlockStat[];
  countEth: boolean;
  countToken: boolean;
  /** click on a column */
  onOpen?: (blockNumber: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (blocks.length === 0) return null;

  const last = blocks[blocks.length - 1];
  const lastSplit = splitBlock(last, countEth, countToken);
  const what = countEth && countToken ? "transactions" : "counted calls";
  const shown = hover !== null ? blocks[hover] : last;
  const shownSplit = hover !== null ? splitBlock(shown, countEth, countToken) : lastSplit;

  return (
    <div className="strip">
      <div className="stripHead">
        <div>
          <span className="stripNum" style={{ color: COLOR.okText }}>
            {fmtInt(lastSplit.signable)}
          </span>
          <span className="muted"> of </span>
          <span className="stripNum">{fmtInt(lastSplit.counted)}</span>
          <span className="muted">
            {" "}
            {what} in the last block are clear-signable · <b>{fmtPct(lastSplit.pct)}</b>
          </span>
        </div>
        <div className="muted small">
          last {blocks.length} blocks · ~{Math.round((blocks.length * 12) / 60)} min{onOpen && " · click a block for details"}
        </div>
      </div>

      <div className="stripBars" onMouseLeave={() => setHover(null)}>
        {blocks.map((b, i) => {
          const s = splitBlock(b, countEth, countToken);
          const isLast = i === blocks.length - 1;
          return (
            <div
              key={b.number}
              className={`stripCol ${isLast ? "last" : ""} ${hover === i ? "hover" : ""} ${onOpen ? "clickable" : ""}`}
              onMouseEnter={() => setHover(i)}
              onClick={() => onOpen?.(b.number)}
              role={onOpen ? "button" : undefined}
              tabIndex={onOpen ? 0 : undefined}
              onKeyDown={(e) => e.key === "Enter" && onOpen?.(b.number)}
              aria-label={`block ${b.number}: ${s.signable} of ${s.counted} clear-signable`}
            >
              <div className="stripRest" style={{ height: `${100 - s.pct}%` }} />
              <div className="stripSig" style={{ height: `${s.pct}%` }} />
            </div>
          );
        })}
        {hover !== null && (
          <div
            className="stripTip"
            style={{ left: `${((hover + 0.5) / blocks.length) * 100}%` }}
            role="tooltip"
          >
            <div className="mono">block {fmtInt(shown.number)}</div>
            <div>
              <b style={{ color: COLOR.ok }}>{fmtInt(shownSplit.signable)}</b> clear-signable ·{" "}
              <b style={{ color: COLOR.no }}>{fmtInt(shownSplit.counted - shownSplit.signable)}</b> not ·{" "}
              {fmtPct(shownSplit.pct)}
            </div>
            <div className="muted">
              {fmtInt(shown.total)} txs · {fmtInt(shown.eth)} ETH · {fmtInt(shown.tokenStd)} token ·{" "}
              {fmtInt(shown.coveredOther)} covered · {fmtInt(shown.notCovered)} not covered
            </div>
          </div>
        )}
      </div>

      <div className="stripAxis mono muted small">
        <span>{fmtInt(blocks[0].number)}</span>
        <span>{fmtInt(last.number)}</span>
      </div>
      <div className="legend small">
        <div className="legendItem">
          <span className="swatch" style={{ background: COLOR.ok }} /> clear-signable
        </div>
        <div className="legendItem">
          <span className="swatch" style={{ background: "#ffccd0" }} /> not clear-signable
        </div>
        <div className="legendItem muted">bar height = share of the block's {what}</div>
      </div>
    </div>
  );
}
