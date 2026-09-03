/**
 * Live section: the block follower's rolling-window stats, the last-blocks
 * strip, a ticker of the newest transactions, and the window rankings —
 * updated over Server-Sent Events as blocks land.
 *
 * New transactions do not enter the ticker on their own: they wait in a
 * buffer and a banner offers to show them, so the list never shifts under the
 * reader. The block line, the strip and the stats do update live.
 */

import { useEffect, useRef, useState } from "react";
import type { BlockStat, LatestBlock, LiveBlockEvent, LiveSummary, LiveTx } from "./types.ts";
import { STANDARD_TOKEN_SELECTORS, excludeParam, fmtInt, fmtPct, signablePct } from "./buckets.ts";
import { BucketBar, Toggle } from "./BucketBar.tsx";
import { BlockStrip } from "./BlockStrip.tsx";
import { RankingPanel } from "./RankingPanel.tsx";
import { clip, CLIP_TEXT, fnName, iconFor, who } from "./txMeta.ts";

type Win = "1h" | "24h" | "7d";
const WINDOWS: Win[] = ["1h", "24h", "7d"];
const WINDOW_LABEL: Record<Win, string> = { "1h": "Last hour", "24h": "Last 24 hours", "7d": "Last 7 days" };

/**
 * Keep `--topbar-h` equal to the sticky top bar's height, so the window bar
 * can stick right under it whatever the bar's wrapped height is.
 */
function useTopbarHeight(): void {
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>(".topbar");
    if (!bar) return;
    const apply = () => document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
}
const TICKER_MAX = 100;
/** raw rows kept; the visible list is this minus whatever the toggles hide */
const TICKER_RAW_MAX = 400;
/** rows that can wait in the banner before the oldest are dropped (a block has ~100–300 rows) */
const PENDING_MAX = 3000;
const STRIP_BLOCKS = 60;
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

function mergeTxs(incoming: LiveTx[], prev: LiveTx[], cap = TICKER_RAW_MAX): LiveTx[] {
  const seen = new Set(incoming.map((t) => t.hash));
  return incoming.concat(prev.filter((t) => !seen.has(t.hash))).slice(0, cap);
}

function mergeBlocks(prev: BlockStat[], incoming: BlockStat[]): BlockStat[] {
  const byNum = new Map(prev.map((b) => [b.number, b]));
  for (const b of incoming) byNum.set(b.number, b);
  return [...byNum.values()].sort((a, b) => a.number - b.number).slice(-STRIP_BLOCKS);
}

export function LivePanel({
  state,
  onInspect,
  onOpenBlock,
  onLatest,
}: {
  state: ToggleState;
  onInspect: (hash: string) => void;
  onOpenBlock?: (blockNumber: number) => void;
  onLatest?: (latest: LatestBlock | null) => void;
}) {
  const [latest, setLatest] = useState<LatestBlock | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [win, setWin] = useState<Win>("24h");
  useTopbarHeight();
  const [summary, setSummary] = useState<LiveSummary | null>(null);
  const [txs, setTxs] = useState<LiveTx[]>([]);
  /** rows that arrived over the stream and are not shown yet */
  const [pending, setPending] = useState<LiveTx[]>([]);
  /** every block that landed since the list was last rendered, as a range (kept even when rows are dropped) */
  const [pendingRange, setPendingRange] = useState<{ lo: number; hi: number } | null>(null);
  const [blocks, setBlocks] = useState<BlockStat[]>([]);
  const [connected, setConnected] = useState(false);
  /** user-triggered refetches in flight (window or toggle change); > 0 shows the page overlay */
  const [busy, setBusy] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [activeHash, setActiveHash] = useState<string | null>(null);
  const winRef = useRef<Win>(win);
  const lastFetchRef = useRef(0);
  /** latest toggle state, readable from the SSE handler */
  const togglesRef = useRef({ countEth: state.countEth, countToken: state.countToken });
  togglesRef.current = { countEth: state.countEth, countToken: state.countToken };
  /** hashes present when the list was last (re)loaded; rows not in here get the entry animation */
  const shownRef = useRef<Set<string> | null>(null);

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
    if (!r.ok) return;
    const rows = (await r.json()) as LiveTx[];
    shownRef.current = new Set(rows.map((t) => t.hash));
    setTxs(rows);
    setPending([]);
    setPendingRange(null);
  }

  // Initial load.
  useEffect(() => {
    (async () => {
      try {
        const l = await fetch("/api/live/latest").then((r) => r.json());
        setLatest(l.latest ?? null);
        onLatest?.(l.latest ?? null);
        if (l.latest) {
          const [s, recent, bs] = await Promise.all([
            fetch(`/api/live/summary?window=${winRef.current}&limit=50${exclude()}`).then((r) => r.json()),
            fetch(`/api/live/recent?limit=${TICKER_MAX}${exclude()}`).then((r) => r.json()),
            fetch(`/api/live/blocks?limit=${STRIP_BLOCKS}`).then((r) => r.json()),
          ]);
          setSummary(s);
          setTxs(recent);
          setBlocks(bs);
          shownRef.current = new Set((recent as LiveTx[]).map((t) => t.hash));
        }
      } catch {
        /* API down: the empty state below explains */
      } finally {
        shownRef.current ??= new Set();
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run user-triggered fetches under the page overlay; keep it up ≥300 ms so it never just flickers. */
  function withBusy(p: Promise<unknown>) {
    setBusy((b) => b + 1);
    const minShow = new Promise((r) => setTimeout(r, 300));
    void Promise.all([p.catch(() => undefined), minShow]).finally(() => setBusy((b) => b - 1));
  }

  // Window change.
  useEffect(() => {
    winRef.current = win;
    if (latest) withBusy(fetchSummary(win));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win]);

  // Toggle change: the exclusion changes the denominator and the list, so both
  // come from the API again (the list, so it is a full page after filtering).
  useEffect(() => {
    if (!loaded || !latest) return;
    withBusy(Promise.all([fetchSummary(winRef.current), fetchRecent()]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.countEth, state.countToken]);

  // SSE stream. EventSource reconnects on its own. The event carries the plain
  // 24h summary; with an exclusion on, or another window, we refetch instead.
  // New rows go to the pending buffer, not straight into the list.
  useEffect(() => {
    const es = new EventSource("/api/live/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("block", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as LiveBlockEvent;
      setLatest(e.block);
      onLatest?.(e.block);
      setPending((prev) => mergeTxs(e.txs, prev, PENDING_MAX));
      // Track the block range since the last render from the blocks the event
      // announces, so it stays right even if rows are dropped from the buffer.
      const nums = (e.blocks?.length ? e.blocks.map((b) => b.number) : []).concat(e.block.number);
      setPendingRange((r) => {
        const lo = Math.min(r?.lo ?? Infinity, ...nums);
        const hi = Math.max(r?.hi ?? -Infinity, ...nums);
        return { lo, hi };
      });
      if (e.blocks?.length) setBlocks((prev) => mergeBlocks(prev, e.blocks));
      const plain = togglesRef.current.countEth && togglesRef.current.countToken;
      if (winRef.current === "24h" && plain) setSummary(e.summary);
      else if (Date.now() - lastFetchRef.current > REFETCH_MIN_MS) void fetchSummary(winRef.current);
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** rows revealed by the last "show" click, in list order, so each can start its animation a bit later than the one above */
  const revealRef = useRef<Map<string, number>>(new Map());

  function showPending() {
    const order = new Map<string, number>();
    pending
      .filter((t) => !hiddenByToggles(t, togglesRef.current.countEth, togglesRef.current.countToken))
      .forEach((t, i) => order.set(t.hash, i));
    revealRef.current = order;
    setTxs((prev) => mergeTxs(pending, prev));
    setPending([]);
    setPendingRange(null);
    // Once the last row has landed, treat them as shown so nothing re-animates later.
    const settleMs = Math.min(order.size, 40) * 35 + 800;
    setTimeout(() => {
      for (const h of order.keys()) shownRef.current?.add(h);
      revealRef.current = new Map();
    }, settleMs);
  }

  const s = summary;
  const total = s?.totalTx ?? 0;
  const excluding = !state.countEth || !state.countToken;
  const visibleTxs = txs.filter((t) => !hiddenByToggles(t, state.countEth, state.countToken)).slice(0, TICKER_MAX);
  const pendingShown = pending.filter((t) => !hiddenByToggles(t, state.countEth, state.countToken));
  const pendingVisible = pendingShown.length;
  // "block N" or "blocks N to M": every block since the last render, not only
  // the ones whose rows survive the toggles or the buffer cap.
  const pendingBlocks = (() => {
    const r = pendingRange;
    if (!r) return "";
    if (r.lo === r.hi) return `1 block, #${fmtInt(r.lo)}`;
    const n = r.hi - r.lo + 1;
    return `${n} blocks, #${fmtInt(r.lo)} – #${fmtInt(r.hi)}`;
  })();

  return (
    <>
      {busy > 0 && (
        <div className="pageLoading" aria-live="polite">
          <div className="pageLoadingBox">
            <span className="spinner" /> Updating…
          </div>
        </div>
      )}
      {/* The window drives every number on the page, so it stays in view. */}
      <div className="winBar" role="group" aria-label="Time window">
        <span className="winLabel">Window</span>
        <div className="winSel">
          {WINDOWS.map((w) => (
            <button key={w} className={`chip ${win === w ? "on" : ""}`} onClick={() => setWin(w)} aria-pressed={win === w}>
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
        <span className="winHint muted small">applies to every number on this page</span>
      </div>
      <section className="card live">
        <div className="liveHead">
          <h3>
            <span className={`liveDot ${connected ? "on" : ""}`} /> Live · Ethereum mainnet
          </h3>
          {latest && (
            <div className="liveBlock mono small">
              latest block{" "}
              <a href={`https://etherscan.io/block/${latest.number}`} target="_blank" rel="noreferrer">
                {fmtInt(latest.number)}
              </a>{" "}
              with {fmtInt(latest.txCount)} txs · {ago(latest.timeIso, now)}
            </div>
          )}
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
              <div className="heroWrap">
                <div className="hero">
                  <div className="heroNum">{fmtPct(signablePct(s.buckets, total, state.countEth, state.countToken))}</div>
                  <div className="heroLabel">
                    of {excluding ? "contract calls" : "transactions"} in the last {win} clear-signable
                    {s.blocks < s.window.hours * 300 && (
                      <span className="muted"> · {fmtInt(s.blocks)} blocks so far</span>
                    )}
                  </div>
                  <div className="toggles">
                    {/* static chip: the descriptor-covered calls in this window, under the current toggles */}
                    <span className="toggle chip" title="Calls covered by an ERC-7730 descriptor in this window">
                      <span className="swatch" style={{ background: "#4ade80" }} />
                      Descriptor calls · {fmtInt(s.buckets.covered_theory)}
                    </span>
                    <Toggle
                      on={state.countEth}
                      onClick={() => state.setCountEth(!state.countEth)}
                      label={`Include ETH transfers · ${fmtInt(s.native.ethTransfers)}`}
                      swatch="#a9bdee"
                    />
                    <Toggle
                      on={state.countToken}
                      onClick={() => state.setCountToken(!state.countToken)}
                      label={`Include token transfers / approvals · ${fmtInt(s.native.tokenTransfers)}`}
                      swatch="#7693da"
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
                      .{!state.countToken && " Token transfers to tokens that have a descriptor (for example Tether) are excluded too."}
                    </div>
                  )}
                </div>

              </div>

              <div className="liveBar">
                <BucketBar buckets={s.buckets} total={total} />
              </div>

              <BlockStrip blocks={blocks} countEth={state.countEth} countToken={state.countToken} onOpen={onOpenBlock} />

              <div className="tickerHead muted small">
                Newest transactions — click one for details
                {excluding && (
                  <span>
                    {" "}
                    · {[!state.countEth && "ETH transfers", !state.countToken && "token transfers"].filter(Boolean).join(" and ")}{" "}
                    hidden
                  </span>
                )}
              </div>
              {pendingVisible > 0 && (
                <button className="newBanner" onClick={showPending}>
                  {fmtInt(pendingVisible)} new transaction{pendingVisible === 1 ? "" : "s"} arrived{" "}
                  <span className="bannerBlocks">({pendingBlocks})</span> · show
                </button>
              )}
              <div className="ticker">
                <TickerHeader />
                {visibleTxs.map((t) => (
                  <TickerRow
                    key={t.hash}
                    tx={t}
                    fresh={shownRef.current !== null && !shownRef.current.has(t.hash)}
                    delayMs={Math.min(revealRef.current.get(t.hash) ?? 0, 40) * 35}
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

      {latest && (
        <RankingPanel
          win={win}
          exclude={excludeParam(state.countEth, state.countToken)}
          excluding={excluding}
          refreshKey={latest.number}
          onBusy={(d) => setBusy((b) => b + d)}
        />
      )}
    </>
  );
}

function TickerIcon({ tx: t }: { tx: LiveTx }) {
  const { glyph, tip, cls } = iconFor(t);
  return (
    <span className={`tickIcon ${cls ?? ""}`} data-tip={tip} aria-label={tip}>
      {glyph}
    </span>
  );
}

/** Column headers matching TickerRow's grid. `withIndex` = the block-modal variant (#N first, no block column). */
export function TickerHeader({ withIndex = false }: { withIndex?: boolean }) {
  return (
    <div className={`tickRow tickHeader ${withIndex ? "withIdx" : ""}`} aria-hidden="true">
      {withIndex && <span>#</span>}
      <span />
      <span>Function</span>
      {!withIndex && <span>Block</span>}
      <span>Contract</span>
      <span>Clear-signed as</span>
      <span className="tickHash">Tx</span>
    </div>
  );
}

export function TickerRow({
  tx: t,
  fresh,
  delayMs = 0,
  active,
  index,
  onClick,
}: {
  tx: LiveTx;
  fresh: boolean;
  /** stagger for rows revealed together: each starts its entry animation this much later */
  delayMs?: number;
  active: boolean;
  /** position of the transaction in its block; when given it is shown first and the block column is dropped */
  index?: number;
  onClick: () => void;
}) {
  const creation = t.bucket === "contract_creation";
  const signed = t.bucket === "covered_theory" && t.status !== "failed";
  const dim = t.bucket === "not_covered" || creation || (t.bucket === "covered_theory" && t.status === "failed");
  const withIdx = index !== undefined;
  const cls = ["tickRow", active && "active", fresh && "fresh", signed && "signed", dim && "dim", withIdx && "withIdx"]
    .filter(Boolean)
    .join(" ");
  const name = fnName(t);
  return (
    <div
      className={cls}
      style={fresh && delayMs ? { animationDelay: `${delayMs}ms` } : undefined}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      {withIdx && <span className="tickIdx mono muted">#{index}</span>}
      <TickerIcon tx={t} />
      <span className="tickFn mono" title={t.functionSig ? `${t.functionSig}  ${t.selector}` : t.selector}>
        {t.bucket === "eth_transfer" || creation ? (
          <span className="muted">{name ?? ""}</span>
        ) : (
          <a
            href={`https://4byte.sourcify.dev/?q=${t.selector}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {name && <span className="fnName">{clip(name)}</span>}
            <span className="fnSel">{t.selector}</span>
          </a>
        )}
      </span>
      {!withIdx && <span className="tickBlock mono muted">{fmtInt(t.blockNumber)}</span>}
      <span className="tickWho" title={who(t)}>
        {clip(who(t))}
      </span>
      <span className={`tickIntent ${signed ? "" : "muted"}`} title={t.displayText ?? t.intent ?? undefined}>
        {clip(signed ? t.displayText ?? t.intent ?? "" : t.intent ?? (t.warnings[0] ? t.warnings[0].code : ""), CLIP_TEXT)}
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
