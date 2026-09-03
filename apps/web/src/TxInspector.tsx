import { useEffect, useState } from "react";
import { isFieldGroup } from "@ethereum-sourcify/clear-signing";
import type { DisplayModel, DisplayField } from "@ethereum-sourcify/clear-signing";
import { decodeTxHash, type DecodeOutcome } from "./decoder.ts";
import type { FeedItem, LiveTxDetail } from "./types.ts";
import { STATUS_COLOR, fmtInt } from "./buckets.ts";

export interface Example {
  hash: string;
  entity?: string;
  functionSig?: string;
  toAddress: string;
}

type Status = DecodeOutcome["status"];

const STATUS_META: Record<Status, { color: string; text: string }> = {
  clear: { color: "#4ade80", text: "Clear-signed" },
  partial: { color: "#eab308", text: "Clear-signed (with warnings)" },
  raw: { color: "#f87171", text: "Not clear-signable — raw calldata" },
};

const LIVE_TO_STATUS: Record<"pass" | "partial" | "failed", Status> = {
  pass: "clear",
  partial: "partial",
  failed: "raw",
};

/** The reduced record stored when a DisplayModel exceeded the size cap. */
interface TruncatedDisplay {
  truncated: true;
  intent?: DisplayModel["intent"];
  interpolatedIntent?: string;
  warnings: { code: string; message: string }[];
  fieldCount: number;
}

function isTruncated(d: unknown): d is TruncatedDisplay {
  return typeof d === "object" && d !== null && (d as { truncated?: boolean }).truncated === true;
}

export function TxInspector({
  examples,
  feed = [],
  seed,
}: {
  examples: Example[];
  feed?: FeedItem[];
  seed?: string;
}) {
  const [hash, setHash] = useState(seed ?? "");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<DecodeOutcome | null>(null);
  const [stored, setStored] = useState<LiveTxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeHash, setActiveHash] = useState<string | null>(null);

  async function run(h: string) {
    const clean = h.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(clean)) {
      setError("Enter a 66-character mainnet transaction hash (0x + 64 hex).");
      setOutcome(null);
      setStored(null);
      return;
    }
    setLoading(true);
    setError(null);
    setOutcome(null);
    setStored(null);
    setActiveHash(clean.toLowerCase());
    // Stored result (from the follower) and a fresh run, side by side.
    const storedP = fetch(`/api/live/tx/${clean}`)
      .then((r) => (r.ok ? (r.json() as Promise<LiveTxDetail>) : null))
      .catch(() => null);
    try {
      const [s, o] = await Promise.all([storedP, decodeTxHash(clean)]);
      setStored(s);
      setOutcome(o);
    } catch (e) {
      setStored(await storedP);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Load a seeded hash (e.g. clicked from another panel).
  useEffect(() => {
    if (seed) {
      setHash(seed);
      void run(seed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  return (
    <section className="card" id="inspector">
      <h3>Clear-sign a transaction live</h3>
      <p className="muted small">
        Paste any Ethereum mainnet transaction hash, or click one in the live ticker above. The
        dashboard fetches it over RPC and runs the Sourcify library in your browser. If the
        follower already processed it, its stored result is shown alongside for comparison.
      </p>

      <div className="inspectRow">
        <input
          className="mono inspectInput"
          placeholder="0x… transaction hash"
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run(hash)}
        />
        <button className="btn" onClick={() => run(hash)} disabled={loading}>
          {loading ? "Decoding…" : "Decode"}
        </button>
      </div>

      {examples.length > 0 && (
        <div className="examples">
          <span className="muted small">Examples:</span>
          {examples.map((ex) => (
            <button
              key={ex.hash}
              className="chip"
              onClick={() => {
                setHash(ex.hash);
                void run(ex.hash);
              }}
              title={ex.functionSig ?? ex.hash}
            >
              {ex.entity ?? ex.hash.slice(0, 8)}
              {ex.functionSig ? ` · ${ex.functionSig.split("(")[0]}` : ""}
            </button>
          ))}
        </div>
      )}

      {error && <div className="inspectError small">{error}</div>}

      {(stored || outcome) && (
        <div className={`compare ${stored && outcome ? "two" : ""}`}>
          {stored && <StoredView row={stored} />}
          {outcome && (
            <DecodeView
              model={outcome.model}
              status={outcome.status}
              hash={outcome.tx.hash}
              title="Run live now"
              subtitle="fetched over RPC, decoded in your browser"
            />
          )}
        </div>
      )}

      {feed.length > 0 && (
        <div className="feed">
          <div className="feedHead muted small">
            BigQuery sample transactions ({feed.length}) — click one to clear-sign it live
          </div>
          <div className="feedList">
            {feed.map((it) => (
              <button
                key={it.hash}
                className={`feedRow ${activeHash === it.hash.toLowerCase() ? "active" : ""}`}
                onClick={() => run(it.hash)}
                title={it.functionSig ?? it.selector}
              >
                <span className="feedDot" style={{ background: STATUS_COLOR[it.status] }} />
                <span className="feedEntity">{it.entity ?? "?"}</span>
                <span className="feedFn mono">
                  {it.functionSig ? it.functionSig.split("(")[0] : it.selector}
                </span>
                <span className="feedIntent muted">{it.intent ?? ""}</span>
                <span className="feedTx muted">{fmtInt(it.txCount)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** What the follower stored for this transaction when its block landed. */
function StoredView({ row }: { row: LiveTxDetail }) {
  const subtitle = `stored at block ${fmtInt(row.blockNumber)}`;
  if (!row.status || row.display === null) {
    // Not a covered tx: only the bucket was stored, no library run.
    return (
      <div className="decode">
        <div className="decodeHead">
          <span className="decodeTitle">Stored by the follower</span>
          <span className="muted small">{subtitle}</span>
        </div>
        <div className="muted small">
          Bucket <b>{row.bucket.replace("_", " ")}</b>
          {row.bucket === "not_covered" && " — no descriptor in the registry, so the library was not run."}
          {row.bucket === "token_native" && " — standard token function; wallets render it natively."}
          {row.bucket === "eth_transfer" && " — plain ETH send; wallets render it natively."}
        </div>
      </div>
    );
  }
  const status = LIVE_TO_STATUS[row.status];
  if (isTruncated(row.display)) {
    const d = row.display;
    const meta = STATUS_META[status];
    return (
      <div className="decode">
        <div className="decodeHead">
          <span className="decodeTitle">Stored by the follower</span>
          <span className="muted small">{subtitle}</span>
        </div>
        <span className="tag" style={{ color: meta.color, borderColor: meta.color }}>
          ● {meta.text}
        </span>
        {d.interpolatedIntent && <div className="interp">{d.interpolatedIntent}</div>}
        <div className="muted small">
          Display model was too large to store in full ({d.fieldCount} fields). Use the live run
          for the fields.
        </div>
        <WarningList warnings={d.warnings as DisplayModel["warnings"]} />
      </div>
    );
  }
  return (
    <DecodeView
      model={row.display as DisplayModel}
      status={status}
      hash={row.hash}
      title="Stored by the follower"
      subtitle={subtitle}
    />
  );
}

function DecodeView({
  model,
  status,
  hash,
  title,
  subtitle,
}: {
  model: DisplayModel;
  status: Status;
  hash: string;
  title: string;
  subtitle?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <div className="decode">
      <div className="decodeHead">
        <span className="decodeTitle">{title}</span>
        <span className="muted small">
          {subtitle && <>{subtitle} · </>}
          <a className="mono" href={`https://etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">
            {hash.slice(0, 10)}…{hash.slice(-6)}
          </a>
        </span>
      </div>
      <span className="tag statusTag" style={{ color: meta.color, borderColor: meta.color }}>
        ● {meta.text}
      </span>

      {model.rawCalldataFallback ? (
        <div className="rawFallback">
          <div className="muted small">
            No descriptor rendered this call. This is what a wallet shows today:
          </div>
          <div className="mono small">
            selector <b>{model.rawCalldataFallback.selector}</b>
          </div>
          {model.rawCalldataFallback.args.map((a, i) => (
            <div key={i} className="mono raw small">
              arg[{i}] {a}
            </div>
          ))}
        </div>
      ) : (
        <>
          {model.intent && (
            <div className="intent">
              {typeof model.intent === "string"
                ? model.intent
                : Object.entries(model.intent).map(([k, v]) => (
                    <div key={k}>
                      <span className="muted">{k}: </span>
                      {v}
                    </div>
                  ))}
            </div>
          )}
          {model.interpolatedIntent && <div className="interp">{model.interpolatedIntent}</div>}
          <FieldList fields={model.fields} />
          {model.metadata?.contractName && (
            <div className="muted small">Contract: {model.metadata.contractName}</div>
          )}
        </>
      )}

      <WarningList warnings={model.warnings} />
    </div>
  );
}

function FieldList({ fields }: { fields: DisplayModel["fields"] }) {
  if (!fields || fields.length === 0) return null;
  return (
    <div className="fields">
      {fields.map((f, i) =>
        isFieldGroup(f) ? (
          <div key={i} className="fieldGroup">
            {f.label && <div className="fieldGroupLabel">{f.label}</div>}
            {f.fields.map((sf, j) => (
              <FieldRow key={j} field={sf} />
            ))}
          </div>
        ) : (
          <FieldRow key={i} field={f} />
        ),
      )}
    </div>
  );
}

function FieldRow({ field }: { field: DisplayField }) {
  return (
    <div className="fieldRow">
      <div className="fieldLabel muted">{field.label}</div>
      <div className="fieldValue mono">{field.value}</div>
    </div>
  );
}

function WarningList({ warnings }: { warnings: DisplayModel["warnings"] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="warnings">
      {warnings.map((w, i) => (
        <div key={i} className="warnRow small">
          <span className="mono warnCode">{w.code}</span> {w.message}
        </div>
      ))}
    </div>
  );
}
