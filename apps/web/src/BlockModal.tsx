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
import { TickerRow } from "./LivePanel.tsx";

function hidden(t: LiveTx, countEth: boolean, countToken: boolean): boolean {
  if (!countEth && t.bucket === "eth_transfer") return true;
  if (!countToken && STANDARD_TOKEN_SELECTORS.has(t.selector)) return true;
  return false;
}

export function BlockModal({
  number,
  countEth,
  countToken,
  onClose,
  onInspect,
}: {
  number: number;
  countEth: boolean;
  countToken: boolean;
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

  const excluding = !countEth || !countToken;
  const visible = useMemo(() => {
    if (!detail) return [];
    return showAll || !excluding ? detail.txs : detail.txs.filter((t) => !hidden(t, countEth, countToken));
  }, [detail, showAll, excluding, countEth, countToken]);

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
          <Body detail={detail} countEth={countEth} countToken={countToken} visible={visible} showAll={showAll} setShowAll={setShowAll} onInspect={onInspect} />
        )}
      </div>
    </div>
  );
}

function Body({
  detail,
  countEth,
  countToken,
  visible,
  showAll,
  setShowAll,
  onInspect,
}: {
  detail: BlockDetail;
  countEth: boolean;
  countToken: boolean;
  visible: LiveTx[];
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  onInspect: (hash: string) => void;
}) {
  const { block, stat, txs } = detail;
  const split = splitBlock(stat, countEth, countToken);
  const excluding = !countEth || !countToken;
  const hiddenCount = txs.length - txs.filter((t) => !hidden(t, countEth, countToken)).length;
  // The strip's breakdown as a Buckets object for the bar: "token" is every
  // standard token call (covered or not), "covered" the rest of the covered ones.
  const buckets: Buckets = {
    covered_theory: stat.coveredOther,
    eth_transfer: stat.eth,
    token_native: stat.tokenStd,
    not_covered: stat.notCovered,
    contract_creation: stat.creation,
  };
  const when = block.timeIso.replace("T", " ").replace(".000Z", " UTC");

  return (
    <>
      <div className="modalHead">
        <div>
          <div className="modalTitle">Block {fmtInt(block.number)}</div>
          <div className="muted small">
            {when} · {fmtInt(block.txCount)} transactions ·{" "}
            <a className="mono" href={`https://etherscan.io/block/${block.number}`} target="_blank" rel="noreferrer">
              {block.hash.slice(0, 10)}…{block.hash.slice(-6)} ↗
            </a>
          </div>
        </div>
      </div>

      <div className="blockStats">
        <div className="blockStat">
          <div className="statVal" style={{ color: COLOR.okText }}>
            {fmtInt(split.signable)} <span className="muted">of</span> {fmtInt(split.counted)}
          </div>
          <div className="statLbl muted">{excluding ? "counted calls" : "transactions"} clear-signable · {fmtPct(split.pct)}</div>
        </div>
        <div className="blockStat">
          <div className="statVal">{fmtInt(stat.coveredOther)}</div>
          <div className="statLbl muted">covered by a descriptor</div>
        </div>
        <div className="blockStat">
          <div className="statVal">{fmtInt(stat.notCovered)}</div>
          <div className="statLbl muted">not covered</div>
        </div>
        <div className="blockStat">
          <div className="statVal">{fmtInt(stat.tokenStd + stat.eth)}</div>
          <div className="statLbl muted">wallet-native (token + ETH)</div>
        </div>
      </div>

      <BucketBar buckets={buckets} total={stat.total} />

      <div className="tickerHead muted small" style={{ marginTop: 18 }}>
        Transactions in this block — click one for details
        {excluding && hiddenCount > 0 && (
          <>
            {" "}
            · {fmtInt(hiddenCount)} ETH / token transfers{" "}
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
        {visible.map((t) => (
          <TickerRow key={t.hash} tx={t} fresh={false} active={false} onClick={() => onInspect(t.hash)} />
        ))}
        {visible.length === 0 && <div className="muted small" style={{ padding: 12 }}>Nothing to show with the current toggles.</div>}
      </div>
    </>
  );
}
