/**
 * Window ranking: every contract called in the window, ordered by transaction
 * count, with its coverage state. Reading the table top to bottom answers two
 * questions at once: which contracts already help, and which ones to add next.
 */

import { useEffect, useRef, useState } from "react";
import type { LiveRanking, RankedContractRow, RankedSelector } from "./types.ts";
import { fmtInt, fmtPct, short } from "./buckets.ts";
import { canonicalSig, clip, contractUrl, fnShort, knownName, REGISTRY_REPO } from "./txMeta.ts";

const REFETCH_MIN_MS = 30_000;
const PAGE_SIZES = [25, 50, 100] as const;

/** Sourcify verification pill, table-sized. Nothing while the cache has not classified the address. */
function VerifiedMini({ verified }: { verified: boolean | null | undefined }) {
  if (verified === true)
    return (
      <span className="verifyBadge yes mini" data-tip="Verified on Sourcify">
        <img src="/sourcify.png" alt="" /> Verified
      </span>
    );
  if (verified === false)
    return (
      <span className="verifyBadge no mini" data-tip="No verified source on Sourcify; no ABI to write a descriptor from">
        ⊘ Not verified
      </span>
    );
  return null;
}

export function RankingPanel({
  win,
  exclude,
  excluding,
  refreshKey,
  onBusy,
}: {
  win: string;
  /** `&exclude=...` query fragment, "" for none */
  exclude: string;
  excluding: boolean;
  /** changes when a new block lands; the table refetches at most every 30s */
  refreshKey: number;
  /** +1 when a user-triggered load starts, -1 when it ends (drives the page overlay) */
  onBusy?: (delta: 1 | -1) => void;
}) {
  const [data, setData] = useState<LiveRanking | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const lastFetch = useRef(0);
  /** the window+toggles the current page belongs to; null before the first load */
  const loadedFilter = useRef<string | null>(null);
  // `exclude` carries every toggle from the control row, including the
  // unverified-contracts one; the table follows it like the rest of the page.
  const filter = `${win}${exclude}`;

  async function load(userTriggered: boolean, pg: number, size: number) {
    lastFetch.current = Date.now();
    setLoading(true);
    if (userTriggered) onBusy?.(1);
    try {
      const r = await fetch(`/api/live/ranking?window=${win}&limit=${size}&offset=${pg * size}${exclude}`);
      if (r.ok) {
        // An API older than the paging change returns neither `offset` nor
        // `total`; keep the requested offset so ranks never turn into NaN.
        const j = (await r.json()) as Partial<LiveRanking> & Pick<LiveRanking, "window" | "by" | "totalTx">;
        setData({ ...j, offset: typeof j.offset === "number" ? j.offset : pg * size, limit: j.limit ?? size } as LiveRanking);
      }
    } finally {
      setLoading(false);
      if (userTriggered) onBusy?.(-1);
    }
  }

  // A change of window or toggles goes back to page 1 and shows the page
  // overlay (it is the user's doing; the very first load is not). A page flip
  // only dims the table.
  useEffect(() => {
    const filterChanged = loadedFilter.current !== filter;
    if (filterChanged && page !== 0) {
      setPage(0); // this effect runs again with page 0
      return;
    }
    const user = loadedFilter.current !== null && filterChanged;
    loadedFilter.current = filter;
    void load(user, page, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, page, pageSize]);

  useEffect(() => {
    if (Date.now() - lastFetch.current > REFETCH_MIN_MS) void load(false, page, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // `total` is missing when the API predates paging: page blind, "Next" while the page is full.
  const legacyApi = data !== null && typeof data.total !== "number";
  const total = legacyApi ? null : (data?.total ?? 0);
  const pageCount = total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  const rowCount = data?.contracts?.length ?? 0;
  const from = data ? data.offset + 1 : 0;
  const to = data ? data.offset + rowCount : 0;
  const hasNext = pageCount === null ? rowCount >= pageSize : page + 1 < pageCount;

  return (
    <section className="card">
      <div className="rankHead">
        <h3>
          Contracts by transaction count · last {win}
        </h3>
      </div>
      <p className="muted small">
        Every contract called in the window, most transactions first. ✅ has an ERC-7730 descriptor
        for the call, ❌ does not.
        {excluding && " Excluded kinds (see the control row above) are left out."}
        {data && (
          <>
            {" "}
            Share is of the <b>{fmtInt(data.totalTx)}</b> {excluding ? "contract calls" : "transactions"} in the window.
          </>
        )}
      </p>

      {!data ? (
        <div className="muted small">{loading ? "Loading…" : "No data yet."}</div>
      ) : (
        <>
          <div className={loading ? "pageDim" : ""}>
            <ContractTable rows={data.contracts ?? []} offset={data.offset} />
          </div>
          {(rowCount > 0 || page > 0) && (
            <div className="pager">
              <span className="muted small">
                {fmtInt(from)}–{fmtInt(to)}
                {total !== null && <> of {fmtInt(total)} contracts</>}
              </span>
              <div className="pagerBtns">
                <button className="chip" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  ← Previous
                </button>
                <span className="muted small">
                  page {fmtInt(page + 1)}
                  {pageCount !== null && <> / {fmtInt(pageCount)}</>}
                </span>
                <button className="chip" disabled={!hasNext || loading} onClick={() => setPage((p) => p + 1)}>
                  Next →
                </button>
              </div>
              <label className="muted small pagerSize">
                per page{" "}
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(0);
                  }}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {legacyApi && (
            <div className="muted small" style={{ marginTop: 6 }}>
              API is older than the web app; restart <code>npm run api</code> for full paging.
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CoverageBadge({ row }: { row: RankedContractRow }) {
  if (row.txCount > 0 && row.coveredTx === row.txCount) return <span className="badge ok">✅ covered</span>;
  if (row.coveredTx > 0)
    return (
      <span className="badge part" title={`${fmtInt(row.coveredTx)} of ${fmtInt(row.txCount)} calls hit a covered function`}>
        ◐ {fmtPct(row.coveredPct)} covered
      </span>
    );
  if (row.inRegistry)
    return (
      <span className="badge part" title="The registry has a descriptor for this address, but not for the functions being called">
        📄 descriptor, functions missing
      </span>
    );
  return <span className="badge no">❌ not covered</span>;
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
      {s.covered ? "✅" : "❌"} {name ? clip(name) : s.selector}
      <span className="muted">{fmtInt(s.txCount)}</span>
    </a>
  );
}

function ContractCell({ row }: { row: RankedContractRow }) {
  // registry entity, else a known label, else Sourcify's name from the verification cache
  const name = knownName(row.toAddress, row.entity, row.sourcifyName ?? null);
  return (
    <span className="contractCell">
      {name && (
        <span className="contractName" title={name}>
          {clip(name)}
        </span>
      )}
      <span className="contractAddr">
        {row.verified ? (
          <a className="mono muted" href={contractUrl(1, row.toAddress)} target="_blank" rel="noreferrer" title={row.toAddress}>
            {short(row.toAddress)}
          </a>
        ) : (
          <span className="mono muted" title={row.toAddress}>
            {short(row.toAddress)}
          </span>
        )}{" "}
        <VerifiedMini verified={row.verified} />
      </span>
    </span>
  );
}

function ContractTable({ rows, offset }: { rows: RankedContractRow[]; offset: number }) {
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
              <td className="muted rankIdx">{fmtInt(offset + i + 1)}</td>
              <td>
                <ContractCell row={c} />
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
