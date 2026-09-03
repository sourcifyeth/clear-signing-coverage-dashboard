/**
 * "Decoded" view of a transaction's calldata: the matching function's
 * signature and each argument by name and type, decoded with viem.
 *
 * Decoding order:
 *   1. the contract's ABI (Sourcify, following proxies; else the descriptor's
 *      inline ABI; see abi.ts) — argument names are known;
 *   2. a text signature: first the one the live row already carries
 *      (`functionSig`, from the descriptor or the follower's 4byte cache), then
 *      the candidates 4byte.sourcify.dev returns for the selector. Arguments
 *      are labelled by index and type only.
 *
 * Ported from the clear-signing playground's DecodedCalldata component.
 */

import { useEffect, useState } from "react";
import { decodeFunctionData, parseAbiItem, toFunctionSelector, type Abi, type AbiFunction, type Hex } from "viem";
import { fetchAbi, lookupSignatures, type AbiResult } from "./abi.ts";
import { canonicalSig } from "./txMeta.ts";

type Source = AbiResult["source"] | "signature";

type Status =
  | { kind: "loading" }
  | { kind: "failed"; selector: string }
  | { kind: "decoded"; fn: AbiFunction; args: readonly unknown[]; source: Source };

/** The ABI function whose selector matches the calldata (exact, so overloads pick right). */
function functionForSelector(abi: Abi, selector: string): AbiFunction | undefined {
  const fns = abi.filter((item): item is AbiFunction => item.type === "function");
  const want = selector.toLowerCase();
  for (const fn of fns) {
    try {
      if (toFunctionSelector(fn).toLowerCase() === want) return fn;
    } catch {
      /* malformed entry */
    }
  }
  return undefined;
}

function decodeWith(fn: AbiFunction, input: string): readonly unknown[] | null {
  try {
    const { args } = decodeFunctionData({ abi: [fn], data: input as Hex });
    return (args ?? []) as readonly unknown[];
  } catch {
    return null;
  }
}

/** A text signature ("transfer(address,uint256)") as an ABI function, if it parses and matches the selector. */
function functionFromSignature(sig: string, selector: string): AbiFunction | null {
  for (const text of [sig, canonicalSig(sig)]) {
    try {
      const item = parseAbiItem(`function ${text}`);
      if (item.type === "function" && toFunctionSelector(item).toLowerCase() === selector.toLowerCase()) return item;
    } catch {
      /* not parseable in this form */
    }
  }
  return null;
}

async function decodeCalldata(chainId: number, address: string, input: string, descriptorPath: string | null, functionSig: string | null): Promise<Status> {
  const selector = input.slice(0, 10);

  // 1. ABI
  const found = await fetchAbi(chainId, address, descriptorPath);
  if (found) {
    const fn = functionForSelector(found.abi, selector);
    const args = fn ? decodeWith(fn, input) : null;
    if (fn && args) return { kind: "decoded", fn, args, source: found.source };
  }

  // 2. text signatures: the row's own first, then 4byte
  const candidates: string[] = [];
  if (functionSig && functionSig.includes("(")) candidates.push(functionSig);
  candidates.push(...(await lookupSignatures(selector)));
  for (const sig of new Set(candidates)) {
    const fn = functionFromSignature(sig, selector);
    const args = fn ? decodeWith(fn, input) : null;
    if (fn && args) return { kind: "decoded", fn, args, source: "signature" };
  }
  return { kind: "failed", selector };
}

export function signatureOf(fn: AbiFunction): string {
  const params = fn.inputs.map((p) => `${p.type} ${p.name ?? ""}`.trim()).join(", ");
  return `${fn.name}(${params})`;
}

interface ParamLike {
  name?: string | undefined;
  type: string;
  components?: readonly ParamLike[] | undefined;
}

const baseType = (type: string) => type.replace(/\[\d*\]$/, "");
const isArrayType = (type: string) => /\[\d*\]$/.test(type);

function scalarToString(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value === null || value === undefined) return "";
  return "[unsupported value]";
}

/**
 * Turn a decoded value into labelled members. viem returns arrays for `T[]`
 * and for unnamed tuples, and plain objects for tuples whose components have
 * names.
 */
function membersOf(value: unknown, param: ParamLike): { label: string; param: ParamLike; value: unknown }[] | undefined {
  if (isArrayType(param.type)) {
    if (!Array.isArray(value)) return undefined;
    const itemParam: ParamLike = { type: baseType(param.type), components: param.components };
    return value.map((item: unknown, i) => ({ label: String(i), param: itemParam, value: item }));
  }
  if (param.type === "tuple" && param.components) {
    const comps = param.components;
    if (Array.isArray(value)) return comps.map((c, i) => ({ label: c.name || String(i), param: c, value: value[i] }));
    if (typeof value === "object" && value !== null)
      return comps.map((c, i) => ({ label: c.name || String(i), param: c, value: (value as Record<string, unknown>)[c.name ?? String(i)] }));
  }
  return undefined;
}

/** Scalars longer than this (long `bytes`, big strings) start collapsed with a "Show full" link. */
const SCALAR_PREVIEW = 200;

function LongScalar({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  if (text.length <= SCALAR_PREVIEW) return <span className="argScalar">{text}</span>;
  return (
    <span className="argScalar">
      {full ? text : `${text.slice(0, SCALAR_PREVIEW)}…`}{" "}
      <button type="button" className="linkBtn small" onClick={() => setFull(!full)}>
        {full ? "Show less" : `Show full (${text.length.toLocaleString()} chars)`}
      </button>
    </span>
  );
}

function Value({ value, param }: { value: unknown; param: ParamLike }) {
  const members = membersOf(value, param);
  // Dynamic `bytes` go in a small scroll box, like the calldata; other scalars collapse past a length.
  if (!members && param.type === "bytes") {
    const hex = scalarToString(value);
    const bytes = Math.max(0, Math.floor((hex.length - 2) / 2));
    return (
      <>
        <div className="bytesBox mono">{hex}</div>
        <div className="muted byteCount">{bytes.toLocaleString()} bytes</div>
      </>
    );
  }
  if (!members) return <LongScalar text={scalarToString(value)} />;
  if (members.length === 0) return <span className="muted">[]</span>;
  return (
    <div className="argNested">
      {members.map((m, i) => (
        <div key={i} className="argRow">
          <span className="argName">
            {m.label} <span className="argType">{m.param.type}</span>
          </span>
          <Value value={m.value} param={m.param} />
        </div>
      ))}
    </div>
  );
}

const SOURCE_NOTE: Record<Source, string> = {
  sourcify: "Decoded with the verified ABI from Sourcify",
  "sourcify+implementation": "Decoded with the verified ABI from Sourcify (proxy; implementation ABI)",
  descriptor: "Decoded with the ABI in the ERC-7730 descriptor",
  signature: "Decoded from the function signature (4byte.sourcify.dev); parameter names are not known",
};

export function DecodedCalldata({
  chainId,
  address,
  input,
  descriptorPath,
  functionSig,
}: {
  chainId: number;
  address: string;
  input: string;
  descriptorPath: string | null;
  /** the row's known signature, tried before asking 4byte */
  functionSig: string | null;
}) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    void decodeCalldata(chainId, address, input, descriptorPath, functionSig).then((s) => !cancelled && setStatus(s));
    return () => {
      cancelled = true;
    };
  }, [chainId, address, input, descriptorPath, functionSig]);

  if (status.kind === "loading") return <div className="muted small">Decoding…</div>;
  if (status.kind === "failed")
    return (
      <div className="muted small">
        Could not decode: no verified ABI and no known signature for <span className="mono">{status.selector}</span>
      </div>
    );

  return (
    <div className="decoded">
      <div className="muted small decodedSource">{SOURCE_NOTE[status.source]}</div>
      <div className="decodedSig mono">{signatureOf(status.fn)}</div>
      {status.fn.inputs.length > 0 && (
        <div className="args">
          {status.fn.inputs.map((param, i) => (
            <div key={i} className="argRow">
              <span className="argName">
                {param.name || String(i)} <span className="argType">{param.type}</span>
              </span>
              <Value value={status.args[i]} param={param} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
