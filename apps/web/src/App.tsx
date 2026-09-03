import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type { LatestBlock, LiveLatest, Report } from "./types.ts";
import { labelFor } from "./labels.ts";
import { LivePanel, type ToggleState } from "./LivePanel.tsx";
import { TxModal } from "./TxModal.tsx";
import { BucketBar, Toggle, Stat, numOr } from "./BucketBar.tsx";
import { fmtInt, fmtPct, short, signablePct } from "./buckets.ts";
import { REGISTRY_REPO } from "./txMeta.ts";

export function App() {
  const [report, setReport] = useState<Report | null | undefined>(undefined);
  const [meta, setMeta] = useState<LiveLatest | null>(null);
  const [latest, setLatest] = useState<LatestBlock | null>(null);
  // Wallet-native transfers are excluded by default: the question the dashboard
  // answers is about the calls that need a descriptor.
  const [countEth, setCountEth] = useState(false);
  const [countToken, setCountToken] = useState(false);
  const [modalHash, setModalHash] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/live/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMeta)
      .catch(() => setMeta(null));
    // The archived BigQuery snapshot is optional: the live section stands on its own.
    fetch("/api/report/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then(setReport)
      .catch(() => setReport(null));
  }, []);

  const state: ToggleState = { countEth, countToken, setCountEth, setCountToken };

  return (
    <>
      <div className="topbar">
        <div className="topbarInner">
          <a className="brand" href="https://sourcify.dev" target="_blank" rel="noreferrer">
            <img src="/sourcify.png" alt="Sourcify logo" />
            <span className="vt">sourcify.eth</span>
          </a>
          <nav className="topnav">
            <a href={REGISTRY_REPO} target="_blank" rel="noreferrer">
              ERC-7730 Registry ↗
            </a>
            <a href="https://github.com/sourcifyeth/clear-signing" target="_blank" rel="noreferrer">
              Sourcify SDK ↗
            </a>
          </nav>
        </div>
      </div>

    <div className="wrap">
      <header className="head">
        <div>
          <h1>Clear-Signing Coverage</h1>
          <p className="sub">
            Share of Ethereum mainnet transactions that can be clear-signed with ERC-7730
            descriptors, and which contracts to add next.
          </p>
        </div>
        <div className="meta">
          <div>
            <span className="muted">Registry</span>{" "}
            {meta?.registryCommit ? (
              <a className="mono" href={`${REGISTRY_REPO}/commit/${meta.registryCommit}`} target="_blank" rel="noreferrer">
                {meta.registryCommit.slice(0, 8)}
              </a>
            ) : (
              "—"
            )}
          </div>
          <div>
            <span className="muted">Indexed</span>{" "}
            {meta ? `${fmtInt(meta.blocks)} blocks · 7-day retention` : "—"}
          </div>
          <div>
            <span className="muted">Head</span>{" "}
            {latest ? (
              <a className="mono" href={`https://etherscan.io/block/${latest.number}`} target="_blank" rel="noreferrer">
                {fmtInt(latest.number)}
              </a>
            ) : (
              "—"
            )}
          </div>
        </div>
      </header>

      {/* Live: block follower, rankings */}
      <LivePanel state={state} onInspect={setModalHash} onLatest={setLatest} />

      {/* Archived BigQuery snapshot, kept for reference */}
      {report && (
        <details className="archive">
          <summary className="muted small">
            Archived BigQuery snapshot · {report.timeframe.hours}h ending{" "}
            {report.timeframe.endIso.replace("T", " ").replace(".000Z", "Z")} · {fmtInt(report.report.totalTx)} transactions
          </summary>
          <Snapshot report={report} state={state} />
        </details>
      )}

      {modalHash && <TxModal hash={modalHash} onClose={() => setModalHash(null)} />}
    </div>
    </>
  );
}

function Snapshot({ report, state }: { report: Report; state: ToggleState }) {
  const r = report.report;
  const b = r.buckets;
  const total = r.totalTx;

  const chartData = useMemo(() => {
    // The API sends a downsampled cumulative curve over the full ranking, so
    // the chart does not need every ranked contract in the payload.
    if (r.ranking.curve && r.ranking.curve.length > 0) return r.ranking.curve;
    const baseline = r.headline.theoryPlusNativePctOfAll;
    const cap = Math.min(
      r.ranking.contracts.length,
      Math.max((r.ranking.contractsToReach95 || 150) + 15, 150),
    );
    const pts = [{ n: 0, pct: baseline }];
    for (let i = 0; i < cap; i++) {
      pts.push({ n: i + 1, pct: r.ranking.contracts[i].cumulativePct });
    }
    return pts;
  }, [r]);

  return (
    <div className="archiveBody">
      <p className="muted small">
        A one-off BigQuery aggregate, generated {report.generatedAtIso.replace("T", " ").slice(0, 19)} UTC
        {report.registryCommit ? ` against registry ${report.registryCommit.slice(0, 8)}` : ""}. The live
        section above supersedes it; this stays as a reference point.
      </p>

      {/* Hero + toggles */}
      <section className="grid2">
        <div className="card hero">
          <div className="heroNum">{fmtPct(signablePct(b, total, state.countEth, state.countToken))}</div>
          <div className="heroLabel">
            {state.countEth && state.countToken
              ? "of transactions clear-signable"
              : "of the remaining transactions clear-signable"}
          </div>
          <div className="toggles">
            <Toggle on disabled label={`Descriptors ${fmtPct(r.headline.theoryPctOfAll)}`} swatch="#4ade80" />
            <Toggle
              on={state.countEth}
              onClick={() => state.setCountEth(!state.countEth)}
              label={`Include ETH transfers · ${fmtPct((b.eth_transfer / total) * 100)}`}
              swatch="#a9bdee"
            />
            <Toggle
              on={state.countToken}
              onClick={() => state.setCountToken(!state.countToken)}
              label={`Include token transfers · ${fmtPct((b.token_native / total) * 100)}`}
              swatch="#7693da"
            />
          </div>
          {(!state.countEth || !state.countToken) && (
            <div className="disclaimer small">
              Excluding{" "}
              {[
                !state.countEth && `${fmtInt(b.eth_transfer)} ETH transfers`,
                !state.countToken && `${fmtInt(b.token_native)} token transfers / approvals`,
              ]
                .filter(Boolean)
                .join(" and ")}{" "}
              from the total. This snapshot excludes by bucket, so standard token calls
              that already have a descriptor (for example Tether) stay counted.
            </div>
          )}
        </div>

        <div className="card">
          <h3>What it takes to go further</h3>
          <div className="reachRow">
            <div className="reach">
              <div className="reachNum">{numOr(r.ranking.contractsToReach80)}</div>
              <div className="reachLabel">contracts to reach 80%</div>
            </div>
            <div className="reach">
              <div className="reachNum">{numOr(r.ranking.contractsToReach95)}</div>
              <div className="reachLabel">contracts to reach 95%</div>
            </div>
          </div>
          <p className="muted small">
            Adding descriptors for the highest-volume uncovered contracts, in order. Assumes
            wallet-native transfers already count as signable.
          </p>
          <div className="denoms">
            <Stat label="Descriptors, of all txs" value={fmtPct(r.headline.theoryPctOfAll)} />
            <Stat label="Descriptors + native" value={fmtPct(r.headline.theoryPlusNativePctOfAll)} />
            <Stat label="Descriptors, of contract calls" value={fmtPct(r.headline.theoryPctOfContractCalls)} />
          </div>
        </div>
      </section>

      {/* Bucket bar */}
      <section className="card">
        <h3>Where the transactions go</h3>
        <BucketBar buckets={b} total={total} />
      </section>

      {/* Cumulative chart */}
      <section className="card">
        <h3>Coverage as contracts are added</h3>
        <p className="muted small">
          Starting from today’s coverage, each step adds the next highest-volume uncovered
          contract. The curve is steep then flattens — a handful of contracts do most of the
          work.
        </p>
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
              <CartesianGrid stroke="#e5e7eb" />
              <XAxis
                dataKey="n"
                stroke="#6b7280"
                tick={{ fontSize: 12 }}
                label={{ value: "contracts added", position: "insideBottom", offset: -12, fill: "#6b7280" }}
              />
              <YAxis
                domain={[Math.floor(chartData[0].pct / 5) * 5, 100]}
                stroke="#6b7280"
                tick={{ fontSize: 12 }}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 12 }}
                formatter={(v: number) => [`${v.toFixed(2)}%`, "coverage"]}
                labelFormatter={(l) => `${l} contracts added`}
              />
              <ReferenceLine y={80} stroke="#d97706" strokeDasharray="4 4" label={{ value: "80%", fill: "#d97706", position: "insideTopLeft", fontSize: 12 }} />
              <ReferenceLine y={95} stroke="#ae373f" strokeDasharray="4 4" label={{ value: "95%", fill: "#ae373f", position: "insideTopLeft", fontSize: 12 }} />
              <Line type="monotone" dataKey="pct" stroke="#2b50aa" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Ranked table */}
      <section className="card">
        <h3>Contracts to add next</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Contract</th>
              <th className="r">Txs</th>
              <th className="r">Cumulative</th>
              <th>Top function selectors</th>
            </tr>
          </thead>
          <tbody>
            {r.ranking.contracts.slice(0, 50).map((c, i) => {
              const label = labelFor(c.toAddress);
              return (
                <tr key={c.toAddress}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    {label && <span className="tag">{label}</span>}
                    <a
                      className="mono"
                      href={`https://etherscan.io/address/${c.toAddress}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(c.toAddress)}
                    </a>
                  </td>
                  <td className="r">{fmtInt(c.txCount)}</td>
                  <td className="r">{fmtPct(c.cumulativePct)}</td>
                  <td className="mono sels">
                    {c.topSelectors.map((s) => (
                      <a
                        key={s.selector}
                        href={`https://4byte.sourcify.dev/?q=${s.selector}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`${fmtInt(s.txCount)} txs`}
                      >
                        {s.selector}
                      </a>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <footer className="muted small">
        Source: {report.source} · scanned {(report.bytesProcessed / 1e9).toFixed(2)} GB
      </footer>
    </div>
  );
}
