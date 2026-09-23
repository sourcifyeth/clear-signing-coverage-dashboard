/**
 * The per-transaction classifier the follower runs on every block, packaged so
 * the API can run the same logic on demand for a transaction or a block that
 * is not in the live index. Nothing here writes the window tables.
 *
 * One classifier holds: the coverage lookup built from the registry, the
 * descriptor resolver for the registry checkout, and the external data
 * provider (token cache + RPC) the SDK's format() needs.
 */
import { format } from "@ethereum-sourcify/clear-signing";
import { createFilesystemResolver } from "@ethereum-sourcify/clear-signing/filesystem";
import type { DisplayModel, ExternalDataProvider } from "@ethereum-sourcify/clear-signing";
import type { Db, LiveTxIn } from "@ccd/db";
import type { Rpc, RpcTx } from "@ccd/rpc";
import type { CoveredCalldata } from "@ccd/coverage";
import { loadCoverageLookup, key3, type CoverageLookup } from "../coverage/loadCoverageSet.js";
import { loadRegistryIndex } from "../coverage/registryIndex.js";
import { bucketFor } from "../classify.js";
import { classifyModel, intentToString } from "../practical.js";
import { TokenCache, createExternalDataProvider } from "../follower/externalData.js";

export { loadCoverageLookup, key3, type CoverageLookup };
export { lookupSignatures } from "../follower/signatures.js";
export { checkContract, type ContractCheck } from "../follower/contractSync.js";

type ResolverOptions = NonNullable<Parameters<typeof format>[1]>["descriptorResolverOptions"];

export function selectorOf(input: string): string {
  if (!input || input === "0x") return "0x";
  return input.length >= 10 ? input.slice(0, 10).toLowerCase() : input.toLowerCase();
}

export interface LiveClassifier {
  chainId: number;
  cov: CoverageLookup;
  tokens: TokenCache;
  /** bucket + (for covered calls) the SDK's rendering, as the follower stores it */
  classify(t: RpcTx): Promise<LiveTxIn>;
  /** the registry row for a covered (to, selector), for entity / function / descriptor names */
  covered(toAddress: string | null, selector: string): CoveredCalldata | undefined;
}

export function createLiveClassifier(opts: { db: Db; rpc: Rpc; chainId: number; registryPath: string; cov: CoverageLookup }): LiveClassifier {
  const { db, rpc, chainId, registryPath, cov } = opts;
  const resolverOptions: ResolverOptions = {
    type: "custom" as const,
    resolver: createFilesystemResolver({ index: loadRegistryIndex(registryPath), descriptorDirectory: registryPath }),
  };
  const tokens = new TokenCache(db, rpc, chainId);
  const externalDataProvider: ExternalDataProvider = createExternalDataProvider({ db, rpc, chainId, tokens });

  async function classify(t: RpcTx): Promise<LiveTxIn> {
    const to = t.to ? t.to.toLowerCase() : null;
    const selector = selectorOf(t.input);
    const { bucket } = bucketFor(to, selector, chainId, cov);
    const row: LiveTxIn = { hash: t.hash, toAddress: to, selector, bucket };
    if (bucket !== "covered_theory" || to === null) return row;

    let model: DisplayModel;
    try {
      let value: bigint | undefined;
      try {
        value = t.value ? BigInt(t.value) : undefined;
      } catch {
        value = undefined;
      }
      model = await format(
        { chainId, to, data: t.input, value, from: t.from },
        { descriptorResolverOptions: resolverOptions, externalDataProvider },
      );
    } catch (e) {
      model = { warnings: [{ code: "UNEXPECTED_LIB_ERROR" as never, message: String(e) }] };
    }
    row.status = classifyModel(model);
    row.warnings = (model.warnings ?? []).map((w) => ({ code: String(w.code), message: w.message }));
    row.intent = model.interpolatedIntent ?? intentToString(model.intent);
    row.display = model; // stored for pass, partial and failed alike (capped in @ccd/db)
    return row;
  }

  return {
    chainId,
    cov,
    tokens,
    classify,
    covered: (to, selector) => (to === null ? undefined : cov.bySelector.get(key3(chainId, to, selector))),
  };
}
