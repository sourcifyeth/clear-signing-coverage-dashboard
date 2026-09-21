/**
 * Block modal: one block's header, its clear-signable split under the current
 * toggles, the bucket breakdown, and every transaction the follower stored
 * for it. A click on a transaction opens the transaction modal in its place.
 */

import { useEffect, useMemo, useState } from "react";
import type { BlockDetail, Buckets, LiveTx } from "./types.ts";
import { COLOR, STANDARD_TOKEN_SELECTORS, fmtInt, fmtPct } from "./buckets.ts";
import { BucketBar } from "./BucketBar.tsx";
import { splitBlock } from "./BlockStrip.tsx";
import { TickerHeader, TickerRow } from "./LivePanel.tsx";

function hidden(t: LiveTx, countEth: boolean, countToken: boolean, countUnverified: boolean): boolean {
  if (!countEth && t.bucket === "eth_transfer") return true;
  if (!countToken && STANDARD_TOKEN_SELECTORS.has(t.selector)) return true;
  if (!countUnverified && t.bucket === "not_covered" && t.verified === false) return true;
  return false;
}

/** "call" / "calls" after a stat number, in a lighter style. */
function Unit({ n }: { n: number }) {
  return <span className="statUnit">{n === 1 ? "call" : "calls"}</span>;
}

/** A row with its position in the block (the follower stores rows in block order). */
type IndexedTx = { tx: LiveTx; index: number };

/**
 * Does a wallet get a readable screen for this transaction? Covered calls that
 * rendered, plus the wallet-native kinds (only when they are included).
 */
function signable(t: LiveTx, countEth: boolean, countToken: boolean): boolean {
  if (t.bucket === "covered_theory") return t.status !== "failed";
  if (t.bucket === "eth_transfer") return countEth;
  if (t.bucket === "token_native") return countToken;
  return false;
}

export function BlockModal({
  number,
  countEth,
  countToken,
  countUnverified = true,
  onClose,
  onInspect,
}: {
  number: number;
  countEth: boolean;
  countToken: boolean;
  countUnverified?: boolean;
  onClose: () => void;
  onInspect: (hash: string) => void;
}) {
  const [detail, setDetail] = useState<BlockDetail | null | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setDetail(undefined);
    fetch(`/api/live/block/${number}`)
      .then((r) => (r.ok ? (r.json() as Promise<BlockDetail>) : null))
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [number]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const excluding = !countEth || !countToken || !countUnverified;
  // Rows carry their block position, then the toggles filter, then
  // clear-signable rows come first (each group in block order).
  const visible = useMemo<IndexedTx[]>(() => {
    if (!detail) return [];
    const all = detail.txs.map((tx, index) => ({ tx, index }));
    const kept = showAll || !excluding ? all : all.filter((r) => !hidden(r.tx, countEth, countToken, countUnverified));
    const yes = kept.filter((r) => signable(r.tx, countEth, countToken));
    const no = kept.filter((r) => !signable(r.tx, countEth, countToken));
    return yes.concat(no);
  }, [detail, showAll, excluding, countEth, countToken, countUnverified]);

  return (
    <div className="modalOverlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <button className="modalClose" onClick={onClose} aria-label="Close">
          ×
        </button>
        {detail === undefined ? (
          <div className="muted small">Loading…</div>
        ) : detail === null ? (
          <>
            <h3>Block {fmtInt(number)} is not in the live index</h3>
            <p className="muted small">It is older than the retention window, or it landed while the follower was down.</p>
          </>
        ) : (
          <Body
            detail={detail}
            countEth={countEth}
            countToken={countToken}
            countUnverified={countUnverified}
            visible={visible}
            showAll={showAll}
            setShowAll={setShowAll}
            onInspect={onInspect}
          />
        )}
      </div>
    </div>
  );
}

function Body({
  detail,
  countEth,
  countToken,
  countUnverified,
  visible,
  showAll,
  setShowAll,
  onInspect,
}: {
  detail: BlockDetail;
  countEth: boolean;
  countToken: boolean;
  countUnverified: boolean;
  visible: IndexedTx[];
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  onInspect: (hash: string) => void;
}) {
  const { block, stat, txs } = detail;
  const split = splitBlock(stat, countEth, countToken, countUnverified);
  const excluding = !countEth || !countToken || !countUnverified;
  const hiddenCount = txs.length - txs.filter((t) => !hidden(t, countEth, countToken, countUnverified)).length;
  const unv = stat.notCoveredUnverified ?? 0;
  // The strip's breakdown as a Buckets object for the bar, under the toggles:
  // "token" is every standard token call (covered or not), "covered" the rest
  // of the covered ones; an excluded kind is left out, as on the main bar.
  const buckets: Buckets = {
    covered_theory: stat.coveredOther,
    eth_transfer: countEth ? stat.eth : 0,
    token_native: countToken ? stat.tokenStd : 0,
    not_covered: stat.notCovered - (countUnverified ? 0 : unv),
    contract_creation: stat.creation,
  };
  const barTotal = stat.total - (countEth ? 0 : stat.eth) - (countToken ? 0 : stat.tokenStd) - (countUnverified ? 0 : unv);
  const when = block.timeIso.replace("T", " ").replace(".000Z", " UTC");

  return (
    <>
      <div className="modalHead">
        <div>
          <div className="modalTitle">Block {fmtInt(block.number)}</div>
          <div className="muted small">
            {when} · {fmtInt(block.txCount)} transactions ·{" "}
            <a href={`https://etherscan.io/block/${block.number}`} target="_blank" rel="noreferrer" title={`block hash ${block.hash}`}>
              Explorer ↗
            </a>
          </div>
        </div>
      </div>

      <div className="blockStats">
        <div className="blockStat">
          <div className="statVal" style={{ color: COLOR.okText }}>
            {fmtInt(split.signable)} <span className="muted">/ {fmtInt(split.counted)}</span> <Unit n={split.counted} />
          </div>
          <div className="statLbl muted">{excluding ? "counted calls" : "transactions"} clear-signable · {fmtPct(split.pct)}</div>
        </div>
        <div className="blockStat">
          <div className="statVal">
            {fmtInt(stat.coveredOther)} <Unit n={stat.coveredOther} />
          </div>
          <div className="statLbl muted">covered by a descriptor</div>
        </div>
        <div className="blockStat">
          <div className="statVal">
            {fmtInt(buckets.not_covered)} <Unit n={buckets.not_covered} />
          </div>
          <div className="statLbl muted">not covered{!countUnverified && unv > 0 && ` · ${fmtInt(unv)} to unverified contracts excluded`}</div>
        </div>
        <div className="blockStat">
          <div className="statVal">
            {fmtInt(stat.tokenStd + stat.eth)} <Unit n={stat.tokenStd + stat.eth} />
          </div>
          <div className="statLbl muted">wallet-native (token or ETH transfer)</div>
        </div>
      </div>

      <BucketBar buckets={buckets} total={barTotal} unverified={countUnverified ? stat.notCoveredUnverified : undefined} />

      <div className="tickerHead muted small" style={{ marginTop: 18 }}>
        Transactions in this block — click one for details
        {excluding && hiddenCount > 0 && (
          <>
            {" "}
            · {fmtInt(hiddenCount)} excluded transaction{hiddenCount === 1 ? "" : "s"}{" "}
            {showAll ? (
              <button className="linkBtn" onClick={() => setShowAll(false)}>
                hide
              </button>
            ) : (
              <>
                hidden ·{" "}
                <button className="linkBtn" onClick={() => setShowAll(true)}>
                  show all
                </button>
              </>
            )}
          </>
        )}
      </div>
      <div className="ticker tall">
        <TickerHeader withIndex />
        {visible.map((r, i) => {
          const isSignable = signable(r.tx, countEth, countToken);
          const firstOfGroup = i === 0 || signable(visible[i - 1].tx, countEth, countToken) !== isSignable;
          return (
            <div key={r.tx.hash} className="tickGroup">
              {firstOfGroup && (
                <div className="tickGroupLabel muted small">
                  {isSignable
                    ? `Clear-signable · ${visible.filter((v) => signable(v.tx, countEth, countToken)).length}`
                    : `Not clear-signable · ${visible.filter((v) => !signable(v.tx, countEth, countToken)).length}`}
                </div>
              )}
              <TickerRow tx={r.tx} index={r.index} fresh={false} active={false} onClick={() => onInspect(r.tx.hash)} />
            </div>
          );
        })}
        {visible.length === 0 && <div className="muted small" style={{ padding: 12 }}>Nothing to show with the current toggles.</div>}
      </div>
    </>
  );
}
