/**
 * Transaction modal: what the follower stored for one transaction when its
 * block landed — the bucket, the function, and for covered calls the full
 * clear-signed display model the Sourcify library produced.
 */

import { useEffect, useState } from "react";
import { isFieldGroup } from "@ethereum-sourcify/clear-signing";
import type { DisplayModel, DisplayField } from "@ethereum-sourcify/clear-signing";
import type { LiveTxDetail } from "./types.ts";
import { fmtInt } from "./buckets.ts";
import { canonicalSig, contractName, iconFor, REGISTRY_REPO } from "./txMeta.ts";

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

export function TxModal({ hash, onClose }: { hash: string; onClose: () => void }) {
  const [row, setRow] = useState<LiveTxDetail | null | undefined>(undefined);

  useEffect(() => {
    setRow(undefined);
    fetch(`/api/live/tx/${hash}`)
      .then((r) => (r.ok ? (r.json() as Promise<LiveTxDetail>) : null))
      .then(setRow)
      .catch(() => setRow(null));
  }, [hash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="modalOverlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modalClose" onClick={onClose} aria-label="Close">
          ×
        </button>
        {row === undefined ? (
          <div className="muted small">Loading…</div>
        ) : row === null ? (
          <>
            <h3>Transaction not in the live index</h3>
            <p className="muted small">
              The follower has no row for{" "}
              <a className="mono" href={`https://etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">
                {hash.slice(0, 10)}…{hash.slice(-6)}
              </a>
              . It is older than the retention window, or it landed while the follower was down.
            </p>
          </>
        ) : (
          <TxBody row={row} />
        )}
      </div>
    </div>
  );
}

function TxBody({ row }: { row: LiveTxDetail }) {
  const icon = iconFor(row);
  const sig = row.functionSig ? canonicalSig(row.functionSig) : null;
  return (
    <>
      <div className="modalHead">
        <span className={`tickIcon big ${icon.cls ?? ""}`}>{icon.glyph}</span>
        <div>
          <div className="modalTitle">{icon.tip}</div>
          <div className="muted small">
            block {fmtInt(row.blockNumber)} · {row.blockTimeIso.replace("T", " ").replace(".000Z", " UTC")} ·{" "}
            <a className="mono" href={`https://etherscan.io/tx/${row.hash}`} target="_blank" rel="noreferrer">
              {row.hash.slice(0, 10)}…{row.hash.slice(-6)} ↗
            </a>
          </div>
        </div>
      </div>

      <div className="modalMeta">
        <div className="metaRow">
          <span className="muted">Contract</span>
          <span>
            {row.toAddress ? (
              <>
                <b>{contractName(row.toAddress, row.entity)}</b>{" "}
                <a className="mono muted" href={`https://etherscan.io/address/${row.toAddress}`} target="_blank" rel="noreferrer">
                  {row.toAddress}
                </a>
              </>
            ) : (
              "— (contract creation)"
            )}
          </span>
        </div>
        {row.bucket !== "eth_transfer" && row.bucket !== "contract_creation" && (
          <div className="metaRow">
            <span className="muted">Function</span>
            <span className="mono">
              {sig ?? <span className="muted">unknown signature</span>}{" "}
              <a className="fnSel" href={`https://4byte.sourcify.dev/?q=${row.selector}`} target="_blank" rel="noreferrer">
                {row.selector}
              </a>
            </span>
          </div>
        )}
        {row.descriptorPath && (
          <div className="metaRow">
            <span className="muted">Descriptor</span>
            <span>
              <a className="mono" href={`${REGISTRY_REPO}/blob/master/${row.descriptorPath}`} target="_blank" rel="noreferrer">
                {row.descriptorPath} ↗
              </a>
            </span>
          </div>
        )}
      </div>

      <Result row={row} />
    </>
  );
}

function Result({ row }: { row: LiveTxDetail }) {
  if (row.bucket === "eth_transfer")
    return <p className="modalNote">A plain ETH send. Wallets show the amount and the recipient natively; no descriptor is involved.</p>;
  if (row.bucket === "contract_creation")
    return <p className="modalNote">A contract deployment. There is nothing to clear-sign.</p>;
  if (row.bucket === "token_native")
    return (
      <p className="modalNote">
        A standard token transfer or approval. Wallets render it from the token's own metadata, so it
        counts as clear-signable without a registry descriptor. The follower did not run the library on it.
      </p>
    );
  if (row.bucket === "not_covered")
    return (
      <p className="modalNote warn">
        No ERC-7730 descriptor covers this call, so a wallet shows raw calldata: the selector and the
        ABI-encoded arguments as hex. Adding a descriptor for this contract would fix every transaction
        like this one.
      </p>
    );

  // covered_theory: show what the library produced
  if (row.display === null)
    return <p className="modalNote">Covered by a descriptor, but the follower stored no display model for this row (it predates that column).</p>;
  if (isTruncated(row.display)) {
    const d = row.display;
    return (
      <div className="decode">
        {d.interpolatedIntent && <div className="interp">{d.interpolatedIntent}</div>}
        <div className="muted small">The display model was too large to store in full ({d.fieldCount} fields).</div>
        <WarningList warnings={d.warnings as DisplayModel["warnings"]} />
      </div>
    );
  }
  return <DecodeView model={row.display as DisplayModel} />;
}

function DecodeView({ model }: { model: DisplayModel }) {
  const fieldWarnings = countFieldWarnings(model.fields);
  return (
    <div className="decode">
      <div className="muted small">
        What the wallet shows, as rendered by the Sourcify library when the block landed.
        {fieldWarnings > 0 && (
          <span className="fieldWarnCount">
            {" "}
            ⚠️ {fieldWarnings} field warning{fieldWarnings === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {model.rawCalldataFallback ? (
        <div className="rawFallback">
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
          {model.metadata?.contractName && <div className="muted small">Contract: {model.metadata.contractName}</div>}
        </>
      )}
      <WarningList warnings={model.warnings} />
    </div>
  );
}

/** Field-level warnings, counted through groups. These do not change the pass/partial status. */
export function countFieldWarnings(fields: DisplayModel["fields"]): number {
  let n = 0;
  for (const f of fields ?? []) {
    if (isFieldGroup(f)) {
      if (f.warning) n++;
      n += countFieldWarnings(f.fields);
    } else if (f.warning) n++;
  }
  return n;
}

function FieldWarning({ warning }: { warning?: { code: string; message: string } }) {
  if (!warning) return null;
  return (
    <div className="fieldWarn small">
      <span className="mono warnCode">{warning.code}</span> {warning.message}
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
            <FieldWarning warning={f.warning} />
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
    <div className={`fieldRow ${field.warning ? "warned" : ""}`}>
      <div className="fieldMain">
        <div className="fieldLabel muted">{field.label}</div>
        <div className="fieldValue mono">{field.value}</div>
      </div>
      <FieldWarning warning={field.warning} />
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
