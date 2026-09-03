/**
 * Contract ABIs for the "ABI decoded" view of the transaction modal.
 *
 * Source order, like the clear-signing playground:
 *   1. Sourcify (`/v2/contract/<chain>/<address>?fields=abi,proxyResolution`).
 *      When Sourcify says the contract is a proxy and names the
 *      implementation(s), their ABIs are fetched too and put first, so a
 *      proxied call decodes against the implementation's functions.
 *   2. The ERC-7730 descriptor's inline `context.contract.abi`, when the row
 *      has a descriptor path and Sourcify has nothing.
 *
 * Results (including "nothing found") are cached per address for the page's
 * lifetime as promises, so concurrent modals share one request.
 */

import type { Abi } from "viem";
import { REGISTRY_REPO } from "./txMeta.ts";

const SOURCIFY_SERVER = "https://sourcify.dev/server";
/** raw file URL for a repo-relative path on the registry's master branch */
const REGISTRY_RAW = `${REGISTRY_REPO.replace("https://github.com/", "https://raw.githubusercontent.com/")}/master`;

interface SourcifyContract {
  abi?: unknown;
  proxyResolution?: {
    isProxy?: boolean;
    implementations?: { address: string; name?: string }[];
  };
}

export interface AbiResult {
  abi: Abi;
  /** where it came from, for the UI note */
  source: "sourcify" | "sourcify+implementation" | "descriptor";
  /** implementation addresses whose ABI was merged in (proxies) */
  implementations: string[];
}

const cache = new Map<string, Promise<AbiResult | null>>();

async function fetchSourcifyContract(chainId: number, address: string, withProxy: boolean): Promise<SourcifyContract | null> {
  const fields = withProxy ? "abi,proxyResolution" : "abi";
  const res = await fetch(`${SOURCIFY_SERVER}/v2/contract/${chainId}/${address}?fields=${fields}`);
  if (!res.ok) return null;
  return (await res.json()) as SourcifyContract;
}

function abiOf(c: SourcifyContract | null): Abi | null {
  return c && Array.isArray(c.abi) ? (c.abi as Abi) : null;
}

async function fromSourcify(chainId: number, address: string): Promise<AbiResult | null> {
  const contract = await fetchSourcifyContract(chainId, address, true);
  const proxyAbi = abiOf(contract);
  if (!contract || !proxyAbi) return null;
  const impls =
    contract.proxyResolution?.isProxy === true ? (contract.proxyResolution.implementations ?? []).map((i) => i.address) : [];
  const implAbis = await Promise.all(
    impls.map(async (impl) => {
      try {
        return abiOf(await fetchSourcifyContract(chainId, impl, false));
      } catch {
        return null;
      }
    }),
  );
  const merged = implAbis.filter((a): a is Abi => a !== null);
  if (merged.length === 0) return { abi: proxyAbi, source: "sourcify", implementations: [] };
  // Implementation functions first so they win over the proxy's admin functions.
  return {
    abi: [...merged.flat(), ...proxyAbi] as unknown as Abi,
    source: "sourcify+implementation",
    implementations: impls,
  };
}

async function fromDescriptor(descriptorPath: string): Promise<AbiResult | null> {
  const res = await fetch(`${REGISTRY_RAW}/${descriptorPath}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { context?: { contract?: { abi?: unknown } } };
  const abi = data.context?.contract?.abi;
  // The descriptor may carry a URL string instead of an inline ABI; only arrays are usable.
  return Array.isArray(abi) ? { abi: abi as Abi, source: "descriptor", implementations: [] } : null;
}

/**
 * The ABI for a contract, or null when neither Sourcify nor the descriptor has
 * one. Never throws.
 */
export function fetchAbi(chainId: number, address: string, descriptorPath: string | null): Promise<AbiResult | null> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const s = await fromSourcify(chainId, address);
      if (s) return s;
    } catch {
      /* fall through to the descriptor */
    }
    if (!descriptorPath) return null;
    try {
      return await fromDescriptor(descriptorPath);
    } catch {
      return null;
    }
  })();
  cache.set(key, p);
  return p;
}
