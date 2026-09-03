/**
 * Transaction modal: what the follower stored for one transaction when its
 * block landed — the bucket, the function, and for covered calls the full
 * clear-signed display model the Sourcify library produced.
 */

import { useEffect, useState, type ReactNode } from "react";
import { isFieldGroup } from "@ethereum-sourcify/clear-signing";
import type { DisplayModel, DisplayField } from "@ethereum-sourcify/clear-signing";
import type { LiveTxDetail } from "./types.ts";
import { fmtInt } from "./buckets.ts";
import { canonicalSig, clip, CLIP_TEXT, contractName, contractUrl, iconFor, REGISTRY_REPO, SDK_REPO } from "./txMeta.ts";
import { RawTxSection } from "./RawTxSection.tsx";
import { fetchProxyInfo, type ProxyInfo } from "./abi.ts";
import { explainWarning } from "./warningExplainer.ts";

/**
 * Info banner when Sourcify says the target contract is a proxy: the proxy
 * kind and the implementation(s) it points to.
 */
function ProxyBanner({ address }: { address: string }) {
  const [info, setInfo] = useState<ProxyInfo | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setShowAll(false);
    void fetchProxyInfo(1, address).then((i) => !cancelled && setInfo(i));
    return () => {
      cancelled = true;
    };
  }, [address]);
  if (!info?.isProxy) return null;
  const MAX_SHOWN = 3;
  const impls = showAll ? info.implementations : info.implementations.slice(0, MAX_SHOWN);
  const hiddenCount = info.implementations.length - impls.length;
  return (
    <div className="infoBanner" role="note">
      <span className="infoGlyph">ℹ️</span>
      <span>
        <b>Proxy contract</b>
        {info.proxyType && <span className="muted"> · {info.proxyType}</span>}
        {info.implementations.length > 0 && (
          <>
            {" "}
            · implementation{info.implementations.length > 1 ? "s" : ""}{" "}
            {impls.map((impl, i) => (
              <span key={impl.address}>
                {i > 0 && ", "}
                {impl.name && <b>{impl.name} </b>}
                <a className="mono" href={contractUrl(1, impl.address)} target="_blank" rel="noreferrer" title={impl.address}>
                  {impl.address.slice(0, 8)}…{impl.address.slice(-4)} ↗
                </a>
              </span>
            ))}
            {hiddenCount > 0 && (
              <>
                , …{" "}
                <button type="button" className="chipBtn" onClick={() => setShowAll(true)}>
                  Show all ({info.implementations.length})
                </button>
              </>
            )}
            {showAll && info.implementations.length > MAX_SHOWN && (
              <>
                {" "}
                <button type="button" className="chipBtn" onClick={() => setShowAll(false)}>
                  Show less
                </button>
              </>
            )}
          </>
        )}
      </span>
    </div>
  );
}

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

/** Colour of the status banner: green for clear-signed, amber for warnings, red for raw hex, blue for wallet-native. */
function toneOf(row: LiveTxDetail): "ok" | "warn" | "bad" | "info" | "neutral" {
  if (row.bucket === "covered_theory") return row.status === "failed" ? "bad" : row.status === "partial" ? "warn" : "ok";
  if (row.bucket === "not_covered") return "bad";
  if (row.bucket === "contract_creation") return "neutral";
  return "info";
}

/** Headline and one-line explanation for the status banner. */
function bannerText(row: LiveTxDetail): { title: string; sub: string } {
  switch (row.bucket) {
    case "eth_transfer":
      return { title: "ETH transfer", sub: "Wallets show the amount and the recipient natively." };
    case "token_native":
      return { title: "Token transfer / approval", sub: "Wallets show it natively from the token's own metadata." };
    case "contract_creation":
      return { title: "Contract creation", sub: "There is nothing to clear-sign." };
    case "covered_theory":
      if (row.status === "failed") return { title: "Not clear-signable", sub: "A descriptor exists, but the library could not render this call." };
      if (row.status === "partial") return { title: "Clear-signable, with warnings", sub: "The descriptor rendered it, but some fields fell back to raw values." };
      return { title: "Clear-signable", sub: "An ERC-7730 descriptor renders this call in the wallet." };
    default:
      return { title: "Not clear-signable", sub: "No ERC-7730 descriptor covers this call, so the wallet shows raw hex." };
  }
}

function TxBody({ row }: { row: LiveTxDetail }) {
  const icon = iconFor(row);
  const banner = bannerText(row);
  const sig = row.functionSig ? canonicalSig(row.functionSig) : null;
  return (
    <>
      <div className="modalHead">
        <div>
          <div className="modalTitle">
            Transaction <span className="mono">{row.hash.slice(0, 10)}…{row.hash.slice(-6)}</span>{" "}
            <a className="small titleLink" href={`https://etherscan.io/tx/${row.hash}`} target="_blank" rel="noreferrer" title={row.hash}>
              Explorer ↗
            </a>
          </div>
          <div className="muted small">
            block {fmtInt(row.blockNumber)} · {row.blockTimeIso.replace("T", " ").replace(".000Z", " UTC")}
          </div>
        </div>
      </div>

      <div className="modalMeta">
        <div className="metaRow">
          <span className="muted">Contract</span>
          <span>
            {row.toAddress ? (
              <>
                <b title={contractName(row.toAddress, row.entity)}>{clip(contractName(row.toAddress, row.entity))}</b>{" "}
                <a className="mono muted" href={contractUrl(1, row.toAddress)} target="_blank" rel="noreferrer">
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
            <span className="mono" title={sig ?? undefined}>
              {sig ? clip(sig, CLIP_TEXT) : <span className="muted">unknown signature</span>}{" "}
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

      {row.toAddress && <ProxyBanner address={row.toAddress} />}

      <div className={`statusBanner ${toneOf(row)}`} role="status">
        {icon.cls === "eth" ? (
          <span className="tickIcon eth statusGlyph">{icon.glyph}</span>
        ) : (
          <span className="statusGlyph">{icon.glyph}</span>
        )}
        <span>
          <span className="statusTitle">{banner.title}</span>
          <span className="statusSub">{banner.sub}</span>
        </span>
      </div>

      <Result row={row} />
      <RawTxSection hash={row.hash} descriptorPath={row.descriptorPath} functionSig={row.functionSig} />
    </>
  );
}

/**
 * The clear-signed section. Only covered calls have one; for every other
 * kind the status banner already says everything.
 */
function Result({ row }: { row: LiveTxDetail }) {
  if (row.bucket !== "covered_theory") return null;

  let body: ReactNode;
  if (row.display === null)
    body = <p className="modalNote">Covered by a descriptor, but the follower stored no display model for this row (it predates that column).</p>;
  else if (isTruncated(row.display)) {
    const d = row.display;
    body = (
      <div className="decode">
        {d.interpolatedIntent && <div className="interp">{d.interpolatedIntent}</div>}
        <div className="muted small">The display model was too large to store in full ({d.fieldCount} fields).</div>
        <WarningList warnings={d.warnings as DisplayModel["warnings"]} />
      </div>
    );
  } else body = <DecodeView model={row.display as DisplayModel} />;

  return (
    <section className="csCard">
      <div className="csCardTitle">Clear-signed display</div>
      {body}
    </section>
  );
}

function DecodeView({ model }: { model: DisplayModel }) {
  const fieldWarnings = countFieldWarnings(model.fields);
  return (
    <div className="decode">
      <div className="muted small">
        What a wallet can show, rendered by the{" "}
        <a href={SDK_REPO} target="_blank" rel="noreferrer">
          Sourcify Clear-Signing SDK ↗
        </a>
        .
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
    <div className="fieldWarn warnTip" data-tip={explainWarning(warning.code)}>
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
        <div className="fieldValue mono" title={field.value}>
          {clip(field.value, CLIP_TEXT)}
        </div>
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
        <div key={i} className="warnRow warnTip" data-tip={explainWarning(String(w.code))}>
          <span className="mono warnCode">{w.code}</span> {w.message}
        </div>
      ))}
    </div>
  );
}
