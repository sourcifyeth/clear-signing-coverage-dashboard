/**
 * "ABI decoded" view of a transaction's calldata: the matching function's
 * signature and each argument by name and type, decoded with viem against the
 * contract's ABI (Sourcify first, then the descriptor's inline ABI; see abi.ts).
 * Ported from the clear-signing playground's DecodedCalldata component.
 */

import { useEffect, useState } from "react";
import { decodeFunctionData, toFunctionSelector, type Abi, type AbiFunction, type Hex } from "viem";
import { fetchAbi, type AbiResult } from "./abi.ts";

type Status =
  | { kind: "loading" }
  | { kind: "no-abi" }
  | { kind: "no-match"; selector: string; source: AbiResult["source"] }
  | { kind: "decoded"; fn: AbiFunction; args: readonly unknown[]; source: AbiResult["source"]; implementations: string[] };

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

function decode(found: AbiResult, input: string): Status {
  const selector = input.slice(0, 10);
  const fn = functionForSelector(found.abi, selector);
  if (!fn) return { kind: "no-match", selector, source: found.source };
  try {
    const { args } = decodeFunctionData({ abi: [fn], data: input as Hex });
    return { kind: "decoded", fn, args: (args ?? []) as readonly unknown[], source: found.source, implementations: found.implementations };
  } catch {
    return { kind: "no-match", selector, source: found.source };
  }
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

function Value({ value, param }: { value: unknown; param: ParamLike }) {
  const members = membersOf(value, param);
  if (!members) return <span className="argScalar">{scalarToString(value)}</span>;
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

const SOURCE_NOTE: Record<AbiResult["source"], string> = {
  sourcify: "ABI from Sourcify",
  "sourcify+implementation": "ABI from Sourcify (proxy, decoded with the implementation's ABI)",
  descriptor: "ABI from the ERC-7730 descriptor",
};

export function DecodedCalldata({
  chainId,
  address,
  input,
  descriptorPath,
}: {
  chainId: number;
  address: string;
  input: string;
  descriptorPath: string | null;
}) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    void fetchAbi(chainId, address, descriptorPath).then((found) => {
      if (cancelled) return;
      setStatus(found ? decode(found, input) : { kind: "no-abi" });
    });
    return () => {
      cancelled = true;
    };
  }, [chainId, address, input, descriptorPath]);

  if (status.kind === "loading") return <div className="muted small">Fetching ABI…</div>;
  if (status.kind === "no-abi")
    return <div className="muted small">No ABI found: the contract is not verified on Sourcify and the descriptor carries no inline ABI.</div>;
  if (status.kind === "no-match")
    return (
      <div className="muted small">
        No function in the ABI matches selector <span className="mono">{status.selector}</span> ({SOURCE_NOTE[status.source]}).
      </div>
    );

  return (
    <div className="decoded">
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
      <div className="muted small decodedSource">{SOURCE_NOTE[status.source]}</div>
    </div>
  );
}
