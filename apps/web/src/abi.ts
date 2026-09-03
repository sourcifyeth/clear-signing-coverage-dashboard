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

// ---------------------------------------------------------------------------
// Verification status (for the modal's contract row)

export type Verification = { status: "verified"; match: string } | { status: "unverified" } | { status: "unknown" };

const verifyCache = new Map<string, Promise<Verification>>();

/**
 * Is the contract verified on Sourcify? 404 means no; a network failure means
 * "unknown" (the UI then shows nothing). Cached per address, never throws.
 */
export function fetchVerification(chainId: number, address: string): Promise<Verification> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = verifyCache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<Verification> => {
    try {
      const res = await fetch(`${SOURCIFY_SERVER}/v2/contract/${chainId}/${address}`);
      if (res.status === 404) return { status: "unverified" };
      if (!res.ok) return { status: "unknown" };
      const body = (await res.json()) as { match?: string };
      return { status: "verified", match: body.match ?? "match" };
    } catch {
      return { status: "unknown" };
    }
  })();
  verifyCache.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Proxy detection (for the modal's info banner)

export interface ProxyInfo {
  isProxy: boolean;
  /** Sourcify's detector name, e.g. "EIP1967Proxy", "ZeppelinOSProxy", "GnosisSafeProxy" */
  proxyType?: string;
  implementations: { address: string; name?: string }[];
}

const proxyCache = new Map<string, Promise<ProxyInfo | null>>();

/**
 * What Sourcify knows about the contract being a proxy, or null when the
 * contract is not verified there. Never throws; cached per address.
 */
export function fetchProxyInfo(chainId: number, address: string): Promise<ProxyInfo | null> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = proxyCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const res = await fetch(`${SOURCIFY_SERVER}/v2/contract/${chainId}/${address}?fields=proxyResolution`);
      if (!res.ok) return null;
      const body = (await res.json()) as { proxyResolution?: { isProxy?: boolean; proxyType?: string; implementations?: { address: string; name?: string }[] } };
      const pr = body.proxyResolution;
      if (!pr) return { isProxy: false, implementations: [] };
      return { isProxy: pr.isProxy === true, proxyType: pr.proxyType, implementations: pr.implementations ?? [] };
    } catch {
      return null;
    }
  })();
  proxyCache.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Selector -> text signatures (the fallback when no ABI matches)

const FOURBYTE_LOOKUP = "https://api.4byte.sourcify.dev/signature-database/v1/lookup";

interface FourByteEntry {
  name: string;
  filtered: boolean;
  hasVerifiedContract: boolean;
}
interface FourByteResponse {
  ok: boolean;
  result?: { function?: Record<string, FourByteEntry[] | null> };
}

const sigCache = new Map<string, Promise<string[]>>();

/**
 * Candidate text signatures for a selector from Sourcify's 4-byte database,
 * best first: entries seen in a verified contract, then the rest in the
 * database's order. Empty when unknown. Never throws; cached per selector.
 */
export function lookupSignatures(selector: string): Promise<string[]> {
  const sel = selector.toLowerCase();
  const hit = sigCache.get(sel);
  if (hit) return hit;
  const p = (async () => {
    try {
      const res = await fetch(`${FOURBYTE_LOOKUP}?function=${sel}&filter=true`);
      if (!res.ok) return [];
      const body = (await res.json()) as FourByteResponse;
      const entries = body.ok ? (body.result?.function?.[sel] ?? []) : [];
      const verified = entries.filter((e) => e.hasVerifiedContract).map((e) => e.name);
      const rest = entries.filter((e) => !e.hasVerifiedContract).map((e) => e.name);
      return [...new Set([...verified, ...rest])];
    } catch {
      return [];
    }
  })();
  sigCache.set(sel, p);
  return p;
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
