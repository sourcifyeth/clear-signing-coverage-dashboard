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
import type { Report, PracticalReport } from "./types.ts";
import { labelFor } from "./labels.ts";
import { TxInspector } from "./TxInspector.tsx";
import { LivePanel, type ToggleState } from "./LivePanel.tsx";
import { BucketBar, Toggle, Stat, numOr } from "./BucketBar.tsx";
import { fmtInt, fmtPct, short, signablePct } from "./buckets.ts";

export function App() {
  const [report, setReport] = useState<Report | null | undefined>(undefined);
  const [practical, setPractical] = useState<PracticalReport | null>(null);
  // Wallet-native transfers are excluded by default: the question the dashboard
  // answers is about the calls that need a descriptor.
  const [countEth, setCountEth] = useState(false);
  const [countToken, setCountToken] = useState(false);
  const [seedHash, setSeedHash] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Both snapshots are optional: the live section stands on its own.
    fetch("/api/report/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then(setReport)
      .catch(() => setReport(null));
    fetch("/api/practical/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then(setPractical)
      .catch(() => setPractical(null));
  }, []);

  const state: ToggleState = { countEth, countToken, setCountEth, setCountToken };

  function inspect(hash: string) {
    setSeedHash(hash);
    document.getElementById("inspector")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="wrap">
      <header className="head">
        <div>
          <h1>Clear-Signing Coverage</h1>
          <p className="sub">
            Share of Ethereum mainnet transactions that can be clear-signed with ERC-7730
            descriptors, and which contracts to add next.
          </p>
        </div>
        {report && (
          <div className="meta">
            <div>
              <span className="muted">Snapshot</span> {report.timeframe.hours}h ending{" "}
              {report.timeframe.endIso.replace("T", " ").replace(".000Z", "Z")}
            </div>
            <div>
              <span className="muted">Registry</span>{" "}
              {report.registryCommit ? report.registryCommit.slice(0, 8) : "—"}
            </div>
            <div>
              <span className="muted">Generated</span>{" "}
              {report.generatedAtIso.replace("T", " ").slice(0, 19)}
            </div>
          </div>
        )}
      </header>

      {/* Live: block follower */}
      <LivePanel state={state} onInspect={inspect} />

      {/* Live decode (stored result + run now) */}
      <TxInspector
        examples={practical?.report.examples ?? []}
        feed={practical?.report.feed ?? []}
        seed={seedHash}
      />

      {/* Theory vs practice (BigQuery sample) */}
      {practical && <PracticalPanel practical={practical} onInspect={inspect} />}

      {/* 24h BigQuery snapshot */}
      {report === undefined ? (
        <div className="muted small">Loading snapshot…</div>
      ) : report === null ? (
        <section className="card">
          <h3>24h BigQuery snapshot</h3>
          <p className="muted small">
            No snapshot yet. Generate one with <code>npm run stage-b -- --hours 24</code> (needs
            BigQuery credentials), or <code>npm run import-json</code> to load an existing JSON.
          </p>
        </section>
      ) : (
        <Snapshot report={report} state={state} />
      )}
    </div>
  );
}

function Snapshot({ report, state }: { report: Report; state: ToggleState }) {
  const r = report.report;
  const b = r.buckets;
  const total = r.totalTx;
  const tf = report.timeframe;

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
    <>
      <h2 className="sectionTitle">
        24h BigQuery snapshot
        <span className="muted small">
          {" "}
          · {tf.hours}h ending {tf.endIso.replace("T", " ").replace(".000Z", "Z")} · {fmtInt(total)} transactions
        </span>
      </h2>

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
              swatch="#38bdf8"
            />
            <Toggle
              on={state.countToken}
              onClick={() => state.setCountToken(!state.countToken)}
              label={`Include token transfers · ${fmtPct((b.token_native / total) * 100)}`}
              swatch="#818cf8"
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
          <p className="muted small">
            A toggle that is off removes that kind of wallet-native transaction from
            the question entirely, numerator and denominator alike.
          </p>
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
              <CartesianGrid stroke="#1e293b" />
              <XAxis
                dataKey="n"
                stroke="#64748b"
                tick={{ fontSize: 12 }}
                label={{ value: "contracts added", position: "insideBottom", offset: -12, fill: "#64748b" }}
              />
              <YAxis
                domain={[Math.floor(chartData[0].pct / 5) * 5, 100]}
                stroke="#64748b"
                tick={{ fontSize: 12 }}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8 }}
                formatter={(v: number) => [`${v.toFixed(2)}%`, "coverage"]}
                labelFormatter={(l) => `${l} contracts added`}
              />
              <ReferenceLine y={80} stroke="#eab308" strokeDasharray="4 4" label={{ value: "80%", fill: "#eab308", position: "insideTopLeft", fontSize: 12 }} />
              <ReferenceLine y={95} stroke="#f97316" strokeDasharray="4 4" label={{ value: "95%", fill: "#f97316", position: "insideTopLeft", fontSize: 12 }} />
              <Line type="monotone" dataKey="pct" stroke="#4ade80" strokeWidth={2} dot={false} />
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
    </>
  );
}

function PracticalPanel({
  practical,
  onInspect,
}: {
  practical: PracticalReport;
  onInspect: (hash: string) => void;
}) {
  const p = practical.report;
  const c = p.counts;
  const w = practical.sampleWindow;
  const statusColor: Record<string, string> = {
    pass: "#4ade80",
    partial: "#eab308",
    failed: "#f87171",
  };
  return (
    <section className="card">
      <h3>Theory vs practice (BigQuery sample)</h3>
      <p className="muted small">
        Runs the Sourcify clear-signing library on a sample transaction per covered contract
        function, to check it actually renders — not just that a descriptor exists. Sampled
        over {w.hours}h ending {w.endIso.replace("T", " ").replace(".000Z", "Z")}.
      </p>
      <div className="denoms">
        <Stat label="Renders in practice" value={fmtPct(p.txWeighted.practicePct)} />
        <div className="statBox">
          <div className="statVal">
            <span style={{ color: statusColor.pass }}>{c.pass}</span> ·{" "}
            <span style={{ color: statusColor.partial }}>{c.partial}</span> ·{" "}
            <span style={{ color: statusColor.failed }}>{c.failed}</span>
          </div>
          <div className="statLbl muted">pass · partial · failed groups</div>
        </div>
        <Stat label="Covered groups sampled" value={fmtInt(p.sampledGroups)} />
      </div>

      {p.problems.length === 0 ? (
        <p className="small" style={{ color: statusColor.pass, marginTop: 14 }}>
          ✓ Every sampled covered function rendered cleanly — no theory-vs-practice gaps.
        </p>
      ) : (
        <table className="tbl" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Contract</th>
              <th>Function</th>
              <th className="r">Txs</th>
              <th>Warning</th>
            </tr>
          </thead>
          <tbody>
            {p.problems.slice(0, 25).map((pr) => (
              <tr key={`${pr.toAddress}-${pr.selector}`}>
                <td>
                  <span className="tag" style={{ color: statusColor[pr.status] }}>
                    {pr.status}
                  </span>
                </td>
                <td>
                  {pr.entity && <span className="tag">{pr.entity}</span>}
                  <a
                    className="mono"
                    href={`https://etherscan.io/address/${pr.toAddress}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(pr.toAddress)}
                  </a>
                </td>
                <td className="mono small">{pr.functionSig ?? pr.selector}</td>
                <td className="r">{fmtInt(pr.txCount)}</td>
                <td className="small">
                  {pr.warnings[0] ? (
                    <>
                      <span className="mono">{pr.warnings[0].code}</span>
                      <div className="muted">{pr.warnings[0].message}</div>
                    </>
                  ) : (
                    "—"
                  )}
                  {pr.sampleTxHash && (
                    <button className="chip" style={{ marginTop: 6 }} onClick={() => onInspect(pr.sampleTxHash)}>
                      decode sample ↑
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
