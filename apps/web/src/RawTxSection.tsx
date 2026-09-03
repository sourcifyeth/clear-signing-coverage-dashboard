/**
 * "Raw transaction" section of the transaction modal: the transaction as the
 * node has it, fetched on demand from /api/live/tx/:hash/raw (the follower
 * never stores calldata, value or sender). Calldata is shown as hex or, for
 * calls, decoded (see DecodedCalldata.tsx). Ported from the playground's
 * RawTransactionView.
 */

import { useEffect, useState } from "react";
import type { RawTx } from "./types.ts";
import { fmtInt } from "./buckets.ts";
import { contractUrl } from "./txMeta.ts";
import { DecodedCalldata } from "./DecodedCalldata.tsx";

type CalldataMode = "hex" | "decoded";
const MODE_KEY = "ccd.calldataMode";
const CALLDATA_PREVIEW = 130;
const CHAIN_ID = 1;

function loadMode(): CalldataMode {
  try {
    return localStorage.getItem(MODE_KEY) === "decoded" ? "decoded" : "hex";
  } catch {
    return "hex";
  }
}
function saveMode(m: CalldataMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* private mode, blocked storage */
  }
}

/** wei (decimal string) -> "1.5 ETH", trailing zeros trimmed */
export function formatEth(weiDecimal: string): string {
  let wei: bigint;
  try {
    wei = BigInt(weiDecimal);
  } catch {
    return `${weiDecimal} wei`;
  }
  const unit = 10n ** 18n;
  const whole = wei / unit;
  const rest = wei % unit;
  if (rest === 0n) return `${whole.toString()} ETH`;
  return `${whole.toString()}.${rest.toString().padStart(18, "0").replace(/0+$/, "")} ETH`;
}

const TX_TYPES: Record<number, string> = { 0: "legacy", 1: "EIP-2930 (access list)", 2: "EIP-1559", 3: "EIP-4844 (blob)", 4: "EIP-7702 (set code)" };

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; tx: RawTx };

async function loadRaw(hash: string): Promise<Load> {
  let res: Response;
  try {
    res = await fetch(`/api/live/tx/${hash}/raw`);
  } catch (e) {
    return { kind: "error", message: `Could not reach the API (${(e as Error).message}).` };
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!res.ok) {
    if (!isJson) return { kind: "error", message: "The API is older than the web app and has no raw-transaction route; restart `npm run api`." };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { kind: "error", message: body.error ?? `HTTP ${res.status}` };
  }
  return { kind: "ok", tx: (await res.json()) as RawTx };
}

export function RawTxSection({ hash, descriptorPath, functionSig }: { hash: string; descriptorPath: string | null; functionSig: string | null }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [mode, setMode] = useState<CalldataMode>(loadMode);
  const [full, setFull] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    setFull(false);
    void loadRaw(hash).then((l) => !cancelled && setLoad(l));
    return () => {
      cancelled = true;
    };
  }, [hash]);

  const pick = (m: CalldataMode) => {
    setMode(m);
    saveMode(m);
  };

  return (
    <div className="rawSection">
      <div className="rawHead">Raw transaction</div>
      {load.kind === "loading" && <div className="muted small">Loading from the node…</div>}
      {load.kind === "error" && <div className="muted small rawError">{load.message}</div>}
      {load.kind === "ok" && <RawRows tx={load.tx} descriptorPath={descriptorPath} functionSig={functionSig} mode={mode} onMode={pick} full={full} setFull={setFull} />}
    </div>
  );
}

function RawRows({
  tx,
  descriptorPath,
  functionSig,
  mode,
  onMode,
  full,
  setFull,
}: {
  tx: RawTx;
  descriptorPath: string | null;
  functionSig: string | null;
  mode: CalldataMode;
  onMode: (m: CalldataMode) => void;
  full: boolean;
  setFull: (v: boolean) => void;
}) {
  const isCall = tx.to !== null && tx.input.length >= 10;
  const truncated = tx.input.length > CALLDATA_PREVIEW;
  const hex = full || !truncated ? tx.input : `${tx.input.slice(0, CALLDATA_PREVIEW)}…`;
  const showDecoded = isCall && mode === "decoded";

  return (
    <div className="rawRows">
      <div className="metaRow">
        <span className="muted">From</span>
        <span className="mono">{tx.from}</span>
      </div>
      <div className="metaRow">
        <span className="muted">To</span>
        <span className="mono">
          {tx.to ? (
            <a href={contractUrl(CHAIN_ID, tx.to)} target="_blank" rel="noreferrer">
              {tx.to}
            </a>
          ) : (
            <span className="muted">— (contract creation)</span>
          )}
        </span>
      </div>
      <div className="metaRow">
        <span className="muted">Value</span>
        <span>{formatEth(tx.value)}</span>
      </div>
      <div className="metaRow">
        <span className="muted">Calldata</span>
        <span>
          {isCall && (
            <div className="segmented" role="tablist" aria-label="calldata view">
              <button type="button" role="tab" aria-selected={mode === "hex"} className={`seg ${mode === "hex" ? "on" : ""}`} onClick={() => onMode("hex")}>
                Hex
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "decoded"}
                className={`seg ${mode === "decoded" ? "on" : ""}`}
                onClick={() => onMode("decoded")}
              >
                Decoded
              </button>
            </div>
          )}
          {showDecoded ? (
            <DecodedCalldata chainId={CHAIN_ID} address={tx.to as string} input={tx.input} descriptorPath={descriptorPath} functionSig={functionSig} />
          ) : tx.input === "0x" ? (
            <span className="muted">none (0x)</span>
          ) : (
            <div className="hexBox mono">
              {hex}
              {truncated && (
                <>
                  {" "}
                  <button className="linkBtn small" onClick={() => setFull(!full)}>
                    {full ? "Show less" : `Show full (${fmtInt((tx.input.length - 2) / 2)} bytes)`}
                  </button>
                </>
              )}
            </div>
          )}
        </span>
      </div>
      <div className="metaRow">
        <span className="muted">Nonce</span>
        <span>{fmtInt(tx.nonce)}</span>
      </div>
      <div className="metaRow">
        <span className="muted">Gas limit</span>
        <span>{fmtInt(Number(tx.gas))}</span>
      </div>
      <div className="metaRow">
        <span className="muted">Type</span>
        <span>
          {tx.type} <span className="muted">{TX_TYPES[tx.type] ? `· ${TX_TYPES[tx.type]}` : ""}</span>
        </span>
      </div>
    </div>
  );
}
