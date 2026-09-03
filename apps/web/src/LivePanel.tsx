/**
 * Live section: the block follower's rolling-window stats and a ticker of the
 * newest transactions, updated over Server-Sent Events as blocks land.
 */

import { useEffect, useRef, useState } from "react";
import type { LatestBlock, LiveBlockEvent, LiveSummary, LiveTx } from "./types.ts";
import { STANDARD_TOKEN_SELECTORS, STATUS_COLOR, excludeParam, fmtInt, fmtPct, short, signablePct } from "./buckets.ts";
import { BucketBar, Toggle, Stat, numOr } from "./BucketBar.tsx";
import { labelFor } from "./labels.ts";

type Win = "1h" | "24h" | "7d";
const WINDOWS: Win[] = ["1h", "24h", "7d"];
const TICKER_MAX = 100;
/** raw rows kept; the visible list is this minus whatever the toggles hide */
const TICKER_RAW_MAX = 400;
/** min ms between summary refetches when the SSE summary does not apply (other window, or an exclusion is on) */
const REFETCH_MIN_MS = 10_000;

/** Is this row hidden by the toggles? Mirrors the API's `exclude=` semantics. */
function hiddenByToggles(t: LiveTx, countEth: boolean, countToken: boolean): boolean {
  if (!countEth && t.bucket === "eth_transfer") return true;
  if (!countToken && STANDARD_TOKEN_SELECTORS.has(t.selector)) return true;
  return false;
}

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
  return incoming.concat(prev.filter((t) => !seen.has(t.hash))).slice(0, TICKER_RAW_MAX);
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
  /** latest toggle state, readable from the SSE handler */
  const togglesRef = useRef({ countEth: state.countEth, countToken: state.countToken });
  togglesRef.current = { countEth: state.countEth, countToken: state.countToken };
  /** hashes present at first load; rows not in here arrived live and get the entry animation */
  const initialRef = useRef<Set<string> | null>(null);

  // 1s clock for the "Ns ago" label.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const exclude = () => excludeParam(togglesRef.current.countEth, togglesRef.current.countToken);

  async function fetchSummary(w: Win) {
    lastFetchRef.current = Date.now();
    const r = await fetch(`/api/live/summary?window=${w}&limit=50${exclude()}`);
    if (r.ok) setSummary(await r.json());
  }
  async function fetchRecent() {
    const r = await fetch(`/api/live/recent?limit=${TICKER_MAX}${exclude()}`);
    if (r.ok) setTxs((await r.json()) as LiveTx[]);
  }

  // Initial load.
  useEffect(() => {
    (async () => {
      try {
        const l = await fetch("/api/live/latest").then((r) => r.json());
        setLatest(l.latest ?? null);
        if (l.latest) {
          const [s, recent] = await Promise.all([
            fetch(`/api/live/summary?window=${winRef.current}&limit=50${exclude()}`).then((r) => r.json()),
            fetch(`/api/live/recent?limit=${TICKER_MAX}${exclude()}`).then((r) => r.json()),
          ]);
          setSummary(s);
          setTxs(recent);
          initialRef.current = new Set((recent as LiveTx[]).map((t) => t.hash));
        }
      } catch {
        /* API down: the empty state below explains */
      } finally {
        initialRef.current ??= new Set();
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Window change.
  useEffect(() => {
    winRef.current = win;
    if (latest) void fetchSummary(win);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win]);

  // Toggle change: the exclusion changes the denominator and the list, so both
  // come from the API again (the list, so it is a full page after filtering).
  useEffect(() => {
    if (!loaded || !latest) return;
    void fetchSummary(winRef.current);
    void fetchRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.countEth, state.countToken]);

  // SSE stream. EventSource reconnects on its own. The event carries the plain
  // 24h summary; with an exclusion on, or another window, we refetch instead.
  useEffect(() => {
    const es = new EventSource("/api/live/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("block", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as LiveBlockEvent;
      setLatest(e.block);
      setTxs((prev) => mergeTxs(e.txs, prev));
      const plain = togglesRef.current.countEth && togglesRef.current.countToken;
      if (winRef.current === "24h" && plain) setSummary(e.summary);
      else if (Date.now() - lastFetchRef.current > REFETCH_MIN_MS) void fetchSummary(winRef.current);
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = summary;
  const total = s?.totalTx ?? 0;
  const excluding = !state.countEth || !state.countToken;
  const visibleTxs = txs.filter((t) => !hiddenByToggles(t, state.countEth, state.countToken)).slice(0, TICKER_MAX);

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
                  of {excluding ? "contract calls" : "transactions"} in the last {win} clear-signable
                  {s.blocks < (s.window.hours * 300) && (
                    <span className="muted"> · {fmtInt(s.blocks)} blocks so far</span>
                  )}
                </div>
                <div className="toggles">
                  <Toggle on disabled label={`Descriptors ${fmtPct(s.headline.theoryPctOfAll)}`} swatch="#4ade80" />
                  <Toggle
                    on={state.countEth}
                    onClick={() => state.setCountEth(!state.countEth)}
                    label={`Include ETH transfers · ${fmtPct(s.allTx ? (s.native.ethTransfers / s.allTx) * 100 : 0)}`}
                    swatch="#38bdf8"
                  />
                  <Toggle
                    on={state.countToken}
                    onClick={() => state.setCountToken(!state.countToken)}
                    label={`Include token transfers · ${fmtPct(s.allTx ? (s.native.tokenTransfers / s.allTx) * 100 : 0)}`}
                    swatch="#818cf8"
                  />
                </div>
                {excluding && (
                  <div className="disclaimer small">
                    Excluding{" "}
                    <b>
                      {[
                        !state.countEth && `${fmtInt(s.excluded.ethTransfers)} ETH transfers`,
                        !state.countToken && `${fmtInt(s.excluded.tokenTransfers)} token transfers / approvals`,
                      ]
                        .filter(Boolean)
                        .join(" and ")}
                    </b>
                    , {fmtPct(s.allTx ? ((s.excluded.ethTransfers + s.excluded.tokenTransfers) / s.allTx) * 100 : 0)} of
                    the {fmtInt(s.allTx)} transactions in this window. The percentage, the ranking, and the list below
                    cover only the other <b>{fmtInt(s.totalTx)}</b> transactions: the calls that need a descriptor.
                    {!state.countToken && " Token transfers to tokens that have a descriptor (for example Tether) are excluded too."}
                  </div>
                )}
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
                  <Stat
                    label={excluding ? `Contract calls counted, last ${win}` : `Transactions, last ${win}`}
                    value={fmtInt(total)}
                  />
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
              {excluding && (
                <span>
                  {" "}
                  · {[!state.countEth && "ETH transfers", !state.countToken && "token transfers"].filter(Boolean).join(" and ")}{" "}
                  hidden
                </span>
              )}
            </div>
            <div className="ticker">
              {visibleTxs.map((t) => (
                <TickerRow
                  key={t.hash}
                  tx={t}
                  fresh={initialRef.current !== null && !initialRef.current.has(t.hash)}
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

/**
 * Canonical form of a signature: parameter names dropped, e.g.
 * "transfer(address _to, uint256 _value)" -> "transfer(address,uint256)".
 * Tuples keep their nesting. Already-canonical input passes through unchanged.
 */
export function canonicalSig(sig: string): string {
  const open = sig.indexOf("(");
  if (open < 0) return sig;
  const name = sig.slice(0, open).trim();
  const body = sig.slice(open + 1, sig.lastIndexOf(")"));
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const types = parts.map((p) => {
    const s = p.trim();
    if (s.startsWith("(")) {
      // tuple: "(address a, uint256 b)[] name" -> "(address,uint256)[]"
      const end = s.lastIndexOf(")");
      // keep only array suffixes such as "[]" or "[2]", drop the parameter name
      const after = s.slice(end + 1).trim().match(/^(\[[^\]]*\])+/)?.[0] ?? "";
      return canonicalSig(`_${s.slice(0, end + 1)}`).slice(1) + after;
    }
    return s.split(/\s+/)[0];
  });
  return `${name}(${types.join(",")})`;
}

/** Function column: the canonical signature when we know one, else nothing (the selector is shown next to it). */
function fnName(t: LiveTx): string | null {
  if (t.bucket === "eth_transfer") return "ETH transfer";
  if (t.bucket === "contract_creation") return null;
  return t.functionSig ? canonicalSig(t.functionSig) : null;
}

/**
 * Row icon: what a wallet user gets for this transaction.
 *   ✅ clear-signed by a descriptor   ⚠️ clear-signed with warnings
 *   ❌ raw hex (no descriptor, or the library failed)
 *   💸 token transfer / approve (wallet-native)   Ξ plain ETH transfer   📦 contract creation
 * The explanation is a CSS tooltip (data-tip) so it shows at once on hover.
 */
function iconFor(t: LiveTx): { glyph: string; tip: string; cls?: string } {
  switch (t.bucket) {
    case "eth_transfer":
      return { glyph: "Ξ", tip: "ETH transfer — wallets show this natively", cls: "eth" };
    case "token_native":
      return { glyph: "💸", tip: "Token transfer / approve — wallets show this natively" };
    case "contract_creation":
      return { glyph: "📦", tip: "Contract creation" };
    case "covered_theory":
      if (t.status === "failed") return { glyph: "❌", tip: "Descriptor exists, but the library failed" };
      if (t.status === "partial") return { glyph: "⚠️", tip: "Clear-signed, with warnings" };
      return { glyph: "✅", tip: "Clear-signed by an ERC-7730 descriptor" };
    default:
      return { glyph: "❌", tip: "Not clear-signable — the wallet shows raw hex" };
  }
}

function TickerIcon({ tx: t }: { tx: LiveTx }) {
  const { glyph, tip, cls } = iconFor(t);
  return (
    <span className={`tickIcon ${cls ?? ""}`} data-tip={tip} aria-label={tip}>
      {glyph}
    </span>
  );
}

function TickerRow({
  tx: t,
  fresh,
  active,
  onClick,
}: {
  tx: LiveTx;
  fresh: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const creation = t.bucket === "contract_creation";
  const signed = t.bucket === "covered_theory" && t.status !== "failed";
  const dim = t.bucket === "not_covered" || creation || (t.bucket === "covered_theory" && t.status === "failed");
  const cls = ["tickRow", active && "active", fresh && "fresh", signed && "signed", dim && "dim"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} onClick={onClick} role="button" tabIndex={0}>
      <TickerIcon tx={t} />
      <span className="tickFn mono" title={t.functionSig ? `${t.functionSig}  ${t.selector}` : t.selector}>
        {t.bucket === "eth_transfer" || creation ? (
          <span className="muted">{fnName(t) ?? ""}</span>
        ) : (
          <a
            href={`https://4byte.sourcify.dev/?q=${t.selector}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {fnName(t) && <span className="fnName">{fnName(t)}</span>}
            <span className="fnSel">{t.selector}</span>
          </a>
        )}
      </span>
      <span className="tickBlock mono muted">{fmtInt(t.blockNumber)}</span>
      <span className="tickWho">{who(t)}</span>
      <span className={`tickIntent ${signed ? "" : "muted"}`} title={t.displayText ?? t.intent ?? undefined}>
        {signed
          ? t.displayText ?? t.intent ?? ""
          : t.intent ?? (t.warnings[0] ? t.warnings[0].code : "")}
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
