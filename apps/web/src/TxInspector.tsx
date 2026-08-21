import { useEffect, useState } from "react";
import { isFieldGroup } from "@ethereum-sourcify/clear-signing";
import type { DisplayModel, DisplayField } from "@ethereum-sourcify/clear-signing";
import { decodeTxHash, type DecodeOutcome } from "./decoder.ts";
import type { FeedItem } from "./types.ts";

export interface Example {
  hash: string;
  entity?: string;
  functionSig?: string;
  toAddress: string;
}

const fmtInt = (n: number) => n.toLocaleString("en-US");
const DOT: Record<FeedItem["status"], string> = {
  pass: "#4ade80",
  partial: "#eab308",
  failed: "#f87171",
};

const STATUS_META: Record<DecodeOutcome["status"], { color: string; text: string }> = {
  clear: { color: "#4ade80", text: "Clear-signed" },
  partial: { color: "#eab308", text: "Clear-signed (with warnings)" },
  raw: { color: "#f87171", text: "Not clear-signable — raw calldata" },
};

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
  const [error, setError] = useState<string | null>(null);
  const [activeHash, setActiveHash] = useState<string | null>(null);

  async function run(h: string) {
    const clean = h.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(clean)) {
      setError("Enter a 66-character mainnet transaction hash (0x + 64 hex).");
      setOutcome(null);
      return;
    }
    setLoading(true);
    setError(null);
    setOutcome(null);
    setActiveHash(clean.toLowerCase());
    try {
      setOutcome(await decodeTxHash(clean));
    } catch (e) {
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
    <section className="card">
      <h3>Clear-sign a transaction live</h3>
      <p className="muted small">
        Paste any Ethereum mainnet transaction hash. The dashboard fetches it over RPC and
        runs the Sourcify library in your browser — nothing is stored.
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
      {outcome && <DecodeView outcome={outcome} />}

      {feed.length > 0 && (
        <div className="feed">
          <div className="feedHead muted small">
            Transactions we decoded ({feed.length}) — click one to clear-sign it live
          </div>
          <div className="feedList">
            {feed.map((it) => (
              <button
                key={it.hash}
                className={`feedRow ${activeHash === it.hash.toLowerCase() ? "active" : ""}`}
                onClick={() => run(it.hash)}
                title={it.functionSig ?? it.selector}
              >
                <span className="feedDot" style={{ background: DOT[it.status] }} />
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

function DecodeView({ outcome }: { outcome: DecodeOutcome }) {
  const { model, tx, status } = outcome;
  const meta = STATUS_META[status];
  return (
    <div className="decode">
      <div className="decodeHead">
        <span className="tag" style={{ color: meta.color, borderColor: meta.color }}>
          ● {meta.text}
        </span>
        <a
          className="mono small"
          href={`https://etherscan.io/tx/${tx.hash}`}
          target="_blank"
          rel="noreferrer"
        >
          {tx.hash.slice(0, 10)}…{tx.hash.slice(-8)}
        </a>
      </div>

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
          {model.interpolatedIntent && (
            <div className="interp">{model.interpolatedIntent}</div>
          )}
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
