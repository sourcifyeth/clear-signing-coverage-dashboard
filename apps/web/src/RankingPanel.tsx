/**
 * Window ranking: every contract (or every function) called in the window,
 * ordered by transaction count, with its coverage state. Reading the table top
 * to bottom answers two questions at once: which contracts already help, and
 * which ones to add next.
 */

import { useEffect, useRef, useState } from "react";
import type { LiveRanking, RankedContractRow, RankedFunctionRow, RankedSelector } from "./types.ts";
import { fmtInt, fmtPct, short } from "./buckets.ts";
import { canonicalSig, contractName, fnShort, REGISTRY_REPO } from "./txMeta.ts";

type By = "contract" | "function";
const REFETCH_MIN_MS = 30_000;

export function RankingPanel({
  win,
  exclude,
  excluding,
  refreshKey,
}: {
  win: string;
  /** `&exclude=...` query fragment, "" for none */
  exclude: string;
  excluding: boolean;
  /** changes when a new block lands; the table refetches at most every 30s */
  refreshKey: number;
}) {
  const [by, setBy] = useState<By>("contract");
  const [data, setData] = useState<LiveRanking | null>(null);
  const [loading, setLoading] = useState(false);
  const lastFetch = useRef(0);

  async function load() {
    lastFetch.current = Date.now();
    setLoading(true);
    try {
      const r = await fetch(`/api/live/ranking?window=${win}&by=${by}&limit=100${exclude}`);
      if (r.ok) setData(await r.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, by, exclude]);

  useEffect(() => {
    if (Date.now() - lastFetch.current > REFETCH_MIN_MS) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return (
    <section className="card">
      <div className="rankHead">
        <h3>
          {by === "contract" ? "Contracts" : "Functions"} by transaction count · last {win}
        </h3>
        <div className="rankTabs">
          <button className={`chip ${by === "contract" ? "on" : ""}`} onClick={() => setBy("contract")}>
            Contracts
          </button>
          <button className={`chip ${by === "function" ? "on" : ""}`} onClick={() => setBy("function")}>
            Functions
          </button>
        </div>
      </div>
      <p className="muted small">
        Every {by === "contract" ? "contract" : "function"} called in the window, most transactions first.{" "}
        <span className="mark" style={{ color: "#2b50aa" }}>✓</span> has an ERC-7730 descriptor for the call,{" "}
        <span className="mark" style={{ color: "#ae373f" }}>✕</span> does not.
        {excluding && " ETH and standard token transfers are left out, as set above."}
        {data && (
          <>
            {" "}
            Share is of the <b>{fmtInt(data.totalTx)}</b> {excluding ? "contract calls" : "transactions"} in the window.
          </>
        )}
      </p>

      {!data ? (
        <div className="muted small">{loading ? "Loading…" : "No data yet."}</div>
      ) : by === "contract" ? (
        <ContractTable rows={data.contracts ?? []} />
      ) : (
        <FunctionTable rows={data.functions ?? []} />
      )}
    </section>
  );
}

function CoverageBadge({ row }: { row: RankedContractRow }) {
  if (row.txCount > 0 && row.coveredTx === row.txCount)
    return (
      <span className="badge ok">
        <span className="mark">✓</span> covered
      </span>
    );
  if (row.coveredTx > 0)
    return (
      <span className="badge part" title={`${fmtInt(row.coveredTx)} of ${fmtInt(row.txCount)} calls hit a covered function`}>
        <span className="mark">◐</span> {fmtPct(row.coveredPct)} covered
      </span>
    );
  if (row.inRegistry)
    return (
      <span className="badge part" title="The registry has a descriptor for this address, but not for the functions being called">
        <span className="mark">◔</span> descriptor, functions missing
      </span>
    );
  return (
    <span className="badge no">
      <span className="mark">✕</span> not covered
    </span>
  );
}

function SelectorChip({ s }: { s: RankedSelector }) {
  const name = s.functionSig ? fnShort(canonicalSig(s.functionSig)) : null;
  return (
    <a
      className={`selChip ${s.covered ? "ok" : "no"}`}
      href={`https://4byte.sourcify.dev/?q=${s.selector}`}
      target="_blank"
      rel="noreferrer"
      title={`${s.functionSig ? canonicalSig(s.functionSig) + " " : ""}${s.selector} · ${fmtInt(s.txCount)} txs`}
    >
      <span className="mark">{s.covered ? "✓" : "✕"}</span>
      {name ?? s.selector}
      <span className="muted">{fmtInt(s.txCount)}</span>
    </a>
  );
}

function ContractCell({ toAddress, entity }: { toAddress: string; entity: string | null }) {
  const name = contractName(toAddress, entity);
  const isAddr = name === short(toAddress);
  return (
    <span className="contractCell">
      {!isAddr && <span className="contractName">{name}</span>}
      <a className="mono muted" href={`https://etherscan.io/address/${toAddress}`} target="_blank" rel="noreferrer">
        {short(toAddress)}
      </a>
    </span>
  );
}

function ContractTable({ rows }: { rows: RankedContractRow[] }) {
  if (rows.length === 0) return <div className="muted small">No contract calls in this window.</div>;
  return (
    <div className="tblWrap">
      <table className="tbl rankTbl">
        <thead>
          <tr>
            <th>#</th>
            <th>Contract</th>
            <th>Coverage</th>
            <th className="r">Txs</th>
            <th className="r">Share</th>
            <th className="r">Cum.</th>
            <th>Functions called</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={c.toAddress} className={c.coveredTx === c.txCount ? "rowOk" : c.coveredTx > 0 ? "rowPart" : ""}>
              <td className="muted">{i + 1}</td>
              <td>
                <ContractCell toAddress={c.toAddress} entity={c.entity} />
                {c.entity && (
                  <a
                    className="muted small regLink"
                    href={`${REGISTRY_REPO}/tree/master/registry/${c.entity}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    registry ↗
                  </a>
                )}
              </td>
              <td>
                <CoverageBadge row={c} />
              </td>
              <td className="r">{fmtInt(c.txCount)}</td>
              <td className="r">{fmtPct(c.sharePct)}</td>
              <td className="r muted">{fmtPct(c.cumulativePct)}</td>
              <td>
                <div className="sels">
                  {c.topSelectors.map((s) => (
                    <SelectorChip key={s.selector} s={s} />
                  ))}
                  {c.distinctSelectors > c.topSelectors.length && (
                    <span className="muted small">+{c.distinctSelectors - c.topSelectors.length} more</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FunctionTable({ rows }: { rows: RankedFunctionRow[] }) {
  if (rows.length === 0) return <div className="muted small">No contract calls in this window.</div>;
  return (
    <div className="tblWrap">
      <table className="tbl rankTbl">
        <thead>
          <tr>
            <th>#</th>
            <th>Function</th>
            <th>Contract</th>
            <th>Coverage</th>
            <th className="r">Txs</th>
            <th className="r">Share</th>
            <th className="r">Cum.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f, i) => (
            <tr key={`${f.toAddress}-${f.selector}`} className={f.covered ? "rowOk" : ""}>
              <td className="muted">{i + 1}</td>
              <td className="mono">
                <a href={`https://4byte.sourcify.dev/?q=${f.selector}`} target="_blank" rel="noreferrer">
                  {f.functionSig ? canonicalSig(f.functionSig) : f.selector}
                </a>
                {f.functionSig && <span className="fnSel"> {f.selector}</span>}
              </td>
              <td>
                <ContractCell toAddress={f.toAddress} entity={f.entity} />
              </td>
              <td>
                {f.covered ? (
                  <span className="badge ok">
                    <span className="mark">✓</span> covered
                  </span>
                ) : f.bucket === "token_native" ? (
                  <span className="badge native">
                    <span className="mark">⇄</span> wallet-native
                  </span>
                ) : (
                  <span className="badge no">
                    <span className="mark">✕</span> not covered
                  </span>
                )}
              </td>
              <td className="r">{fmtInt(f.txCount)}</td>
              <td className="r">{fmtPct(f.sharePct)}</td>
              <td className="r muted">{fmtPct(f.cumulativePct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
