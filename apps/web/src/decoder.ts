/**
 * In-browser live decode. Fetches a transaction (via the API's RPC proxy) and
 * runs the Sourcify clear-signing library client-side to produce the same
 * human-readable display a wallet would show — or the raw fallback when no
 * descriptor matches.
 *
 * Descriptors are resolved through a custom resolver backed by the API, which
 * reads them from the local registry checkout. No transaction contents are
 * stored; they are fetched on demand and decoded here.
 */

import {
  format,
  type DisplayModel,
  type Descriptor,
  type RegistryIndex,
  type DescriptorResolver,
} from "@ethereum-sourcify/clear-signing";

export interface FetchedTx {
  chainId: number;
  hash: string;
  to: string | null;
  from: string;
  input: string;
  value: string; // hex quantity
  blockNumber: string;
}

let resolverPromise: Promise<DescriptorResolver> | null = null;

// Build the resolver once and reuse it: the index is fetched a single time,
// descriptors are fetched lazily (and the browser caches the HTTP responses).
function getResolver(): Promise<DescriptorResolver> {
  if (!resolverPromise) {
    resolverPromise = fetch("/api/registry-index")
      .then((r) => {
        if (!r.ok) throw new Error(`registry-index ${r.status}`);
        return r.json() as Promise<RegistryIndex>;
      })
      .then((index) => ({
        index,
        fetchDescriptor: async (p: string): Promise<Descriptor> => {
          const res = await fetch(`/api/descriptor?path=${encodeURIComponent(p)}`);
          if (!res.ok) throw new Error(`descriptor ${p}: ${res.status}`);
          return (await res.json()) as Descriptor;
        },
      }));
  }
  return resolverPromise;
}

export async function fetchTx(hash: string): Promise<FetchedTx> {
  const res = await fetch(`/api/tx/${hash}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `tx ${res.status}`);
  return body as FetchedTx;
}

export interface DecodeOutcome {
  tx: FetchedTx;
  model: DisplayModel;
  status: "clear" | "partial" | "raw";
}

export async function decodeTxHash(hash: string): Promise<DecodeOutcome> {
  const tx = await fetchTx(hash);
  if (!tx.to) throw new Error("Contract-creation transactions have no callee to decode.");

  const resolver = await getResolver();
  let value: bigint | undefined;
  try {
    value = tx.value ? BigInt(tx.value) : undefined;
  } catch {
    value = undefined;
  }

  const model = await format(
    { chainId: tx.chainId, to: tx.to, data: tx.input, value, from: tx.from },
    { descriptorResolverOptions: { type: "custom", resolver } },
  );

  const rendered =
    model.intent !== undefined || (Array.isArray(model.fields) && model.fields.length > 0);
  const status: DecodeOutcome["status"] = model.rawCalldataFallback || !rendered
    ? "raw"
    : model.warnings && model.warnings.length > 0
      ? "partial"
      : "clear";

  return { tx, model, status };
}
