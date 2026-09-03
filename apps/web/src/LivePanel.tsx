/**
 * Live section: the block follower's rolling-window stats and a ticker of the
 * newest transactions, updated over Server-Sent Events as blocks land.
 */

import { useEffect, useRef, useState } from "react";
import type { LatestBlock, LiveBlockEvent, LiveSummary, LiveTx } from "./types.ts";
import { BUCKET_COLOR, STATUS_COLOR, fmtInt, fmtPct, short, signablePct } from "./buckets.ts";
import { BucketBar, Toggle, Stat, numOr } from "./BucketBar.tsx";
import { labelFor } from "./labels.ts";

type Win = "1h" | "24h" | "7d";
const WINDOWS: Win[] = ["1h", "24h", "7d"];
const TICKER_MAX = 100;
/** min ms between summary refetches for non-24h windows (24h comes with each SSE event) */
const REFETCH_MIN_MS = 20_000;

export interface ToggleState {
  countEth: boolean;
  countToken: boolean;
  setCountEth: (v: boolean) => void;
  setCountToken: (v: boolean) => void;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

function mergeTxs(incoming: LiveTx[], prev: LiveTx[]): LiveTx[] {
  const seen = new Set(incoming.map((t) => t.hash));
  return incoming.concat(prev.filter((t) => !seen.has(t.hash))).slice(0, TICKER_MAX);
}

export function LivePanel({ state, onInspect }: { state: ToggleState; onInspect: (hash: string) => void }) {
  const [latest, setLatest] = useState<LatestBlock | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [win, setWin] = useState<Win>("24h");
  const [summary, setSummary] = useState<LiveSummary | null>(null);
  const [txs, setTxs] = useState<LiveTx[]>([]);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [activeHash, setActiveHash] = useState<string | null>(null);
  const winRef = useRef<Win>(win);
  const lastFetchRef = useRef(0);

  // 1s clock for the "Ns ago" label.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function fetchSummary(w: Win) {
    lastFetchRef.current = Date.now();
    const r = await fetch(`/api/live/summary?window=${w}&limit=50`);
    if (r.ok) setSummary(await r.json());
  }

  // Initial load.
  useEffect(() => {
    (async () => {
      try {
        const l = await fetch("/api/live/latest").then((r) => r.json());
        setLatest(l.latest ?? null);
        if (l.latest) {
          const [s, recent] = await Promise.all([
            fetch(`/api/live/summary?window=${winRef.current}&limit=50`).then((r) => r.json()),
            fetch(`/api/live/recent?limit=${TICKER_MAX}`).then((r) => r.json()),
          ]);
          setSummary(s);
          setTxs(recent);
        }
      } catch {
        /* API down: the empty state below explains */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // Window change.
  useEffect(() => {
    winRef.current = win;
    if (latest) void fetchSummary(win);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win]);

  // SSE stream. EventSource reconnects on its own.
  useEffect(() => {
    const es = new EventSource("/api/live/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("block", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as LiveBlockEvent;
      setLatest(e.block);
      setTxs((prev) => mergeTxs(e.txs, prev));
      if (winRef.current === "24h") setSummary(e.summary);
      else if (Date.now() - lastFetchRef.current > REFETCH_MIN_MS) void fetchSummary(winRef.current);
    });
    return () => es.close();
  }, []);

  const s = summary;
  const total = s?.totalTx ?? 0;

  return (
    <section className="card live">
      <div className="liveHead">
        <h3>
          <span className={`liveDot ${connected ? "on" : ""}`} /> Live · Ethereum mainnet
        </h3>
        {latest && (
          <div className="liveBlock mono small">
            block{" "}
            <a href={`https://etherscan.io/block/${latest.number}`} target="_blank" rel="noreferrer">
              {fmtInt(latest.number)}
            </a>{" "}
            · {ago(latest.timeIso, now)} · {latest.txCount} txs
          </div>
        )}
        <div className="winSel">
          {WINDOWS.map((w) => (
            <button key={w} className={`chip ${win === w ? "on" : ""}`} onClick={() => setWin(w)}>
              {w}
            </button>
          ))}
        </div>
      </div>

      {!loaded ? (
        <div className="muted small">Connecting…</div>
      ) : !latest ? (
        <div className="liveEmpty">
          <div>No blocks yet — the follower is not running.</div>
          <div className="muted small">
            Start it with <code>npm run follow</code>. Stats fill up from the moment it starts; the
            24h / 7d windows are complete after that much time.
          </div>
        </div>
      ) : (
        s && (
          <>
            <div className="grid2">
              <div className="hero">
                <div className="heroNum">{fmtPct(signablePct(s.buckets, total, state.countEth, state.countToken))}</div>
                <div className="heroLabel">
                  of the last {win} clear-signable
                  {s.blocks < (s.window.hours * 300) && (
                    <span className="muted"> · {fmtInt(s.blocks)} blocks so far</span>
                  )}
                </div>
                <div className="toggles">
                  <Toggle on disabled label={`Descriptors ${fmtPct(s.headline.theoryPctOfAll)}`} swatch="#4ade80" />
                  <Toggle
                    on={state.countEth}
                    onClick={() => state.setCountEth(!state.countEth)}
                    label={`ETH transfers ${fmtPct(total ? (s.buckets.eth_transfer / total) * 100 : 0)}`}
                    swatch="#38bdf8"
                  />
                  <Toggle
                    on={state.countToken}
                    onClick={() => state.setCountToken(!state.countToken)}
                    label={`Token transfers ${fmtPct(total ? (s.buckets.token_native / total) * 100 : 0)}`}
                    swatch="#818cf8"
                  />
                </div>
                <div className="small practiceLine">
                  Library renders{" "}
                  <b style={{ color: STATUS_COLOR.pass }}>{fmtPct(s.practice.practicePct)}</b> of covered txs ·{" "}
                  <span style={{ color: STATUS_COLOR.pass }}>{fmtInt(s.practice.passTx)}</span> pass ·{" "}
                  <span style={{ color: STATUS_COLOR.partial }}>{fmtInt(s.practice.partialTx)}</span> partial ·{" "}
                  <span style={{ color: STATUS_COLOR.failed }}>{fmtInt(s.practice.failedTx)}</span> failed
                </div>
              </div>

              <div>
                <div className="reachRow">
                  <div className="reach">
                    <div className="reachNum">{numOr(s.ranking.contractsToReach80)}</div>
                    <div className="reachLabel">contracts to reach 80%</div>
                  </div>
                  <div className="reach">
                    <div className="reachNum">{numOr(s.ranking.contractsToReach95)}</div>
                    <div className="reachLabel">contracts to reach 95%</div>
                  </div>
                </div>
                <div className="denoms">
                  <Stat label={`Transactions, last ${win}`} value={fmtInt(total)} />
                  <Stat label="Blocks" value={fmtInt(s.blocks)} />
                  <Stat label="Uncovered contracts" value={fmtInt(s.ranking.totalContracts)} />
                </div>
              </div>
            </div>

            <div className="liveBar">
              <BucketBar buckets={s.buckets} total={total} />
            </div>

            <div className="tickerHead muted small">
              Newest transactions — click one to see it clear-signed
            </div>
            <div className="ticker">
              {txs.map((t) => (
                <TickerRow
                  key={t.hash}
                  tx={t}
                  active={activeHash === t.hash}
                  onClick={() => {
                    setActiveHash(t.hash);
                    onInspect(t.hash);
                  }}
                />
              ))}
            </div>
          </>
        )
      )}
    </section>
  );
}

function who(t: LiveTx): string {
  if (t.bucket === "contract_creation") return "contract creation";
  if (t.entity) return t.entity;
  if (!t.toAddress) return "?";
  return labelFor(t.toAddress) ?? short(t.toAddress);
}

function what(t: LiveTx): string {
  if (t.bucket === "eth_transfer") return "ETH transfer";
  if (t.bucket === "contract_creation") return "";
  if (t.functionSig) return t.functionSig.split("(")[0];
  return t.selector;
}

function TickerRow({ tx: t, active, onClick }: { tx: LiveTx; active: boolean; onClick: () => void }) {
  const creation = t.bucket === "contract_creation";
  return (
    <div className={`tickRow ${active ? "active" : ""}`} onClick={onClick} role="button" tabIndex={0}>
      <span className="tickDots">
        <span className="feedDot" style={{ background: BUCKET_COLOR[t.bucket] }} title={t.bucket} />
        {t.status && (
          <span className="feedDot" style={{ background: STATUS_COLOR[t.status] }} title={`library: ${t.status}`} />
        )}
      </span>
      <span className="tickBlock mono muted">{fmtInt(t.blockNumber)}</span>
      <span className="tickWho">{who(t)}</span>
      <span className="tickFn mono">
        {t.bucket === "eth_transfer" || creation ? (
          <span className="muted">{what(t)}</span>
        ) : (
          <a
            href={`https://4byte.sourcify.dev/?q=${t.selector}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={t.functionSig ?? t.selector}
          >
            {what(t)}
          </a>
        )}
      </span>
      <span className="tickIntent muted" title={t.intent ?? undefined}>
        {t.intent ?? (t.warnings[0] ? t.warnings[0].code : "")}
      </span>
      <a
        className="tickHash mono muted"
        href={`https://etherscan.io/tx/${t.hash}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        {t.hash.slice(0, 8)}…
      </a>
    </div>
  );
}
