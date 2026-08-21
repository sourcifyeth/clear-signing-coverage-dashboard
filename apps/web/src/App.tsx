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
import type { Report } from "./types.ts";
import { labelFor } from "./labels.ts";

const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const BUCKETS = [
  { key: "covered_theory", label: "Covered by descriptor", color: "#4ade80" },
  { key: "eth_transfer", label: "ETH transfer", color: "#38bdf8" },
  { key: "token_native", label: "Token transfer / approve", color: "#818cf8" },
  { key: "not_covered", label: "Not covered", color: "#f87171" },
  { key: "contract_creation", label: "Contract creation", color: "#64748b" },
] as const;

export function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countEth, setCountEth] = useState(true);
  const [countToken, setCountToken] = useState(true);

  useEffect(() => {
    fetch("/api/report/latest")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`API ${r.status}`))))
      .then(setReport)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="wrap">
        <div className="card error">
          <h2>Could not load report</h2>
          <p>{error}</p>
          <p className="muted">
            Start the API (<code>npm run api</code>) and generate a report with{" "}
            <code>npm run stage-b -- --out out/report-24h.json</code>.
          </p>
        </div>
      </div>
    );
  }
  if (!report) return <div className="wrap muted">Loading…</div>;

  return <Dashboard report={report} state={{ countEth, countToken, setCountEth, setCountToken }} />;
}

interface ToggleState {
  countEth: boolean;
  countToken: boolean;
  setCountEth: (v: boolean) => void;
  setCountToken: (v: boolean) => void;
}

function Dashboard({ report, state }: { report: Report; state: ToggleState }) {
  const r = report.report;
  const b = r.buckets;
  const total = r.totalTx;

  const signable =
    b.covered_theory +
    (state.countEth ? b.eth_transfer : 0) +
    (state.countToken ? b.token_native : 0);
  const signablePct = total ? (signable / total) * 100 : 0;

  const chartData = useMemo(() => {
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

  const tf = report.timeframe;

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
        <div className="meta">
          <div>
            <span className="muted">Window</span> {tf.hours}h ending{" "}
            {tf.endIso.replace("T", " ").replace(".000Z", "Z")}
          </div>
          <div>
            <span className="muted">Transactions</span> {fmtInt(total)}
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
      </header>

      {/* Hero + toggles */}
      <section className="grid2">
        <div className="card hero">
          <div className="heroNum">{fmtPct(signablePct)}</div>
          <div className="heroLabel">of transactions clear-signable</div>
          <div className="toggles">
            <Toggle
              on={true}
              disabled
              label={`Descriptors ${fmtPct(r.headline.theoryPctOfAll)}`}
              swatch="#4ade80"
            />
            <Toggle
              on={state.countEth}
              onClick={() => state.setCountEth(!state.countEth)}
              label={`ETH transfers ${fmtPct((b.eth_transfer / total) * 100)}`}
              swatch="#38bdf8"
            />
            <Toggle
              on={state.countToken}
              onClick={() => state.setCountToken(!state.countToken)}
              label={`Token transfers ${fmtPct((b.token_native / total) * 100)}`}
              swatch="#818cf8"
            />
          </div>
          <p className="muted small">
            Toggle whether wallet-native cases (plain ETH sends, standard ERC-20/721
            transfers and approvals) count toward the total.
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
            <Stat
              label="Descriptors + native"
              value={fmtPct(r.headline.theoryPlusNativePctOfAll)}
            />
            <Stat
              label="Descriptors, of contract calls"
              value={fmtPct(r.headline.theoryPctOfContractCalls)}
            />
          </div>
        </div>
      </section>

      {/* Bucket bar */}
      <section className="card">
        <h3>Where the transactions go</h3>
        <div className="bar">
          {BUCKETS.map((bk) => {
            const v = b[bk.key];
            const w = total ? (v / total) * 100 : 0;
            if (w <= 0) return null;
            return (
              <div
                key={bk.key}
                className="barSeg"
                style={{ width: `${w}%`, background: bk.color }}
                title={`${bk.label}: ${fmtInt(v)} (${fmtPct(w)})`}
              />
            );
          })}
        </div>
        <div className="legend">
          {BUCKETS.map((bk) => (
            <div key={bk.key} className="legendItem">
              <span className="swatch" style={{ background: bk.color }} />
              {bk.label}
              <span className="muted"> · {fmtInt(b[bk.key])} · {fmtPct((b[bk.key] / total) * 100)}</span>
            </div>
          ))}
        </div>
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
                        href={`https://www.4byte.directory/signatures/?bytes4_signature=${s.selector}`}
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

function numOr(n: number) {
  return Number.isFinite(n) ? n : "—";
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="statBox">
      <div className="statVal">{value}</div>
      <div className="statLbl muted">{label}</div>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  label,
  swatch,
  disabled,
}: {
  on: boolean;
  onClick?: () => void;
  label: string;
  swatch: string;
  disabled?: boolean;
}) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} onClick={onClick} disabled={disabled}>
      <span className="swatch" style={{ background: swatch, opacity: on ? 1 : 0.3 }} />
      {label}
    </button>
  );
}
