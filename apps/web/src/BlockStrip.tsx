/**
 * "Last blocks" strip: one thin column per block, split into the clear-signable
 * share (bottom, green) and the rest (top, red). The newest block is on the
 * right and gets a headline line above the strip. Hover shows the counts.
 *
 * The split follows the same toggles as the rest of the page: an excluded kind
 * of transaction is left out of the block's denominator.
 */

import { useRef, useState } from "react";
import type { BlockStat } from "./types.ts";
import { COLOR, fmtInt, fmtPct, infraRemovedOf } from "./buckets.ts";

export interface BlockSplit {
  counted: number;
  signable: number;
  pct: number;
  /** not-covered calls to known-unverified contracts that are still counted (0 when excluded) */
  unverified: number;
  /** calls to the bots & infrastructure list that left the denominator (0 when counted) */
  infraExcluded: number;
}

/**
 * Split a block by the toggles: what is counted, and how much of it is
 * clear-signable. An excluded kind leaves the denominator: ETH sends, standard
 * token calls, not-covered calls to contracts Sourcify knows to be
 * unverified, and calls to the bots & infrastructure list. `unverified` = the
 * part of the not-covered calls still counted.
 */
export function splitBlock(b: BlockStat, countEth: boolean, countToken: boolean, countUnverified = true, countInfra = true): BlockSplit {
  const unv = b.notCoveredUnverified ?? 0;
  const infraExcluded = countInfra ? 0 : infraRemovedOf(b, countToken, countUnverified);
  const counted = b.total - (countEth ? 0 : b.eth) - (countToken ? 0 : b.tokenStd) - (countUnverified ? 0 : unv) - infraExcluded;
  const signable = b.coveredOther + (countToken ? b.tokenStd : 0) + (countEth ? b.eth : 0);
  // The listed contracts' unverified calls are in `unv`; when both are excluded they leave once (infraRemovedOf).
  const unvShown = countUnverified ? (countInfra ? unv : Math.max(0, unv - (b.infraUnverified ?? 0))) : 0;
  return { counted, signable, pct: counted > 0 ? (signable / counted) * 100 : 0, unverified: unvShown, infraExcluded };
}

export function BlockStrip({
  blocks,
  countEth,
  countToken,
  countUnverified = true,
  countInfra = true,
  onOpen,
}: {
  blocks: BlockStat[];
  countEth: boolean;
  countToken: boolean;
  countUnverified?: boolean;
  countInfra?: boolean;
  /** click on a column */
  onOpen?: (blockNumber: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  /** highest block present at first render; anything newer arrived live and animates in */
  const initialMax = useRef<number | null>(null);
  if (blocks.length > 0 && initialMax.current === null) initialMax.current = blocks[blocks.length - 1].number;
  if (blocks.length === 0) return null;

  const last = blocks[blocks.length - 1];
  const lastSplit = splitBlock(last, countEth, countToken, countUnverified, countInfra);
  const what = countEth && countToken && countUnverified && countInfra ? "transactions" : "counted calls";
  const shown = hover !== null ? blocks[hover] : last;
  const shownSplit = hover !== null ? splitBlock(shown, countEth, countToken, countUnverified, countInfra) : lastSplit;

  return (
    <div className="strip">
      <div className="stripHead">
        {/* keyed by block so the headline re-mounts and flashes when a new block lands */}
        <div key={last.number} className={last.number > (initialMax.current ?? Infinity) ? "stripHeadFresh" : ""}>
          <span className="stripNum" style={{ color: COLOR.okText }}>
            {fmtInt(lastSplit.signable)}
          </span>
          <span className="muted"> / </span>
          <span className="stripNum muted">{fmtInt(lastSplit.counted)}</span>
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
          const s = splitBlock(b, countEth, countToken, countUnverified, countInfra);
          const isLast = i === blocks.length - 1;
          const fresh = b.number > (initialMax.current ?? Infinity);
          return (
            <div
              key={b.number}
              className={`stripCol ${isLast ? "last" : ""} ${hover === i ? "hover" : ""} ${onOpen ? "clickable" : ""} ${fresh ? "fresh" : ""}`}
              onMouseEnter={() => setHover(i)}
              onClick={() => onOpen?.(b.number)}
              role={onOpen ? "button" : undefined}
              tabIndex={onOpen ? 0 : undefined}
              onKeyDown={(e) => e.key === "Enter" && onOpen?.(b.number)}
              aria-label={`block ${b.number}: ${s.signable} of ${s.counted} clear-signable`}
            >
              {/* top: not-covered calls to unverified contracts; then the rest; bottom: clear-signable */}
              <div className="stripRestUnv" style={{ height: `${s.counted > 0 ? (s.unverified / s.counted) * 100 : 0}%` }} />
              <div className="stripRest" style={{ height: `${Math.max(0, 100 - s.pct - (s.counted > 0 ? (s.unverified / s.counted) * 100 : 0))}%` }} />
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
              {shownSplit.unverified > 0 && <> ({fmtInt(shownSplit.unverified)} unverified)</>}
              {!countUnverified && (shown.notCoveredUnverified ?? 0) > 0 && <> · {fmtInt(shown.notCoveredUnverified ?? 0)} to unverified contracts excluded</>}
              {shownSplit.infraExcluded > 0 && <> · {fmtInt(shownSplit.infraExcluded)} to bots & infrastructure excluded</>}
            </div>
          </div>
        )}
      </div>

      <div className="stripAxis mono muted small">
        <span>{fmtInt(blocks[0].number)}</span>
        <span>{fmtInt(last.number)}</span>
      </div>
    </div>
  );
}
