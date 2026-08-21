/**
 * Stage C: run the Sourcify clear-signing library on a sample transaction per
 * covered (to, selector) group and classify the outcome. This surfaces the gap
 * between "clear-signable in theory" (a descriptor covers the selector) and
 * "in practice" (the library actually renders it).
 *
 * Classification of the DisplayModel:
 *   pass    -> has intent and/or fields, no rawCalldataFallback, no warnings
 *   partial -> renders something (intent/fields) but emitted warnings
 *   failed  -> rawCalldataFallback present, or nothing rendered at all
 */

import { format } from "@ethereum-sourcify/clear-signing";
import { createFilesystemResolver } from "@ethereum-sourcify/clear-signing/filesystem";
import type { DisplayModel, Warning } from "@ethereum-sourcify/clear-signing";
import type { TxSample } from "./bq/samples.js";
import { loadRegistryIndex } from "./coverage/registryIndex.js";
import { type CoverageLookup, key3 } from "./coverage/loadCoverageSet.js";

export type PracticalStatus = "pass" | "partial" | "failed";

export interface PracticalResult {
  toAddress: string;
  selector: string;
  functionSig?: string;
  entity?: string;
  descriptorPath?: string;
  txCount: number;
  status: PracticalStatus;
  intent?: string;
  warnings: Warning[];
  sampleTxHash: string;
}

export interface PracticalReport {
  chainId: number;
  sampledGroups: number;
  counts: { pass: number; partial: number; failed: number };
  txWeighted: {
    coveredSampledTx: number;
    passTx: number;
    partialTx: number;
    failedTx: number;
    /** pass+partial share of sampled covered txs — "renders in practice" */
    practicePct: number;
  };
  /** groups that did not fully pass, worst (highest tx volume) first */
  problems: PracticalResult[];
  /** a few high-volume passing samples, as ready demos for the live inspector */
  examples: { hash: string; entity?: string; functionSig?: string; toAddress: string }[];
  warningCodeTotals: Record<string, number>;
}

function classify(model: DisplayModel): PracticalStatus {
  const rendered =
    model.intent !== undefined ||
    (Array.isArray(model.fields) && model.fields.length > 0);
  if (model.rawCalldataFallback || !rendered) return "failed";
  if (model.warnings && model.warnings.length > 0) return "partial";
  return "pass";
}

function intentToString(intent: DisplayModel["intent"]): string | undefined {
  if (intent === undefined) return undefined;
  if (typeof intent === "string") return intent;
  return Object.entries(intent)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

/**
 * Run the library over the covered samples. `chainId` is fixed to mainnet for
 * v1. `registryPath` is the local registry checkout used by the filesystem
 * resolver.
 */
export async function runPractical(opts: {
  samples: TxSample[];
  cov: CoverageLookup;
  registryPath: string;
  chainId: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<PracticalReport> {
  const { samples, cov, registryPath, chainId } = opts;

  const resolver = createFilesystemResolver({
    index: loadRegistryIndex(registryPath),
    descriptorDirectory: registryPath,
  });
  const resolverOptions = { type: "custom" as const, resolver };

  // Only test groups that are actually covered in theory.
  const covered = samples.filter((s) => cov.bySelector.has(key3(chainId, s.toAddress, s.selector)));

  const results: PracticalResult[] = [];
  let done = 0;
  for (const s of covered) {
    const row = cov.bySelector.get(key3(chainId, s.toAddress, s.selector));
    let model: DisplayModel;
    try {
      let value: bigint | undefined;
      try {
        value = s.value ? BigInt(s.value) : undefined;
      } catch {
        value = undefined; // non-numeric value string — omit rather than crash
      }
      model = await format(
        {
          chainId,
          to: s.toAddress,
          data: s.input,
          value,
          ...(s.fromAddress ? { from: s.fromAddress } : {}),
        },
        { descriptorResolverOptions: resolverOptions },
      );
    } catch (e) {
      model = { warnings: [{ code: "UNEXPECTED_LIB_ERROR", message: String(e) }] };
    }
    results.push({
      toAddress: s.toAddress,
      selector: s.selector,
      functionSig: row?.functionSig,
      entity: row?.entity,
      descriptorPath: row?.descriptorPath,
      txCount: s.txCount,
      status: classify(model),
      intent: intentToString(model.intent),
      warnings: model.warnings ?? [],
      sampleTxHash: s.hash,
    });
    done++;
    opts.onProgress?.(done, covered.length);
  }

  // Aggregate.
  const counts = { pass: 0, partial: 0, failed: 0 };
  const tx = { coveredSampledTx: 0, passTx: 0, partialTx: 0, failedTx: 0 };
  const warningCodeTotals: Record<string, number> = {};
  for (const r of results) {
    counts[r.status]++;
    tx.coveredSampledTx += r.txCount;
    if (r.status === "pass") tx.passTx += r.txCount;
    else if (r.status === "partial") tx.partialTx += r.txCount;
    else tx.failedTx += r.txCount;
    for (const w of r.warnings) warningCodeTotals[w.code] = (warningCodeTotals[w.code] ?? 0) + 1;
  }
  const practicePct = tx.coveredSampledTx
    ? ((tx.passTx + tx.partialTx) / tx.coveredSampledTx) * 100
    : 0;

  const problems = results
    .filter((r) => r.status !== "pass")
    .sort((a, b) => b.txCount - a.txCount);

  const examples = results
    .filter((r) => r.status === "pass")
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 8)
    .map((r) => ({
      hash: r.sampleTxHash,
      entity: r.entity,
      functionSig: r.functionSig,
      toAddress: r.toAddress,
    }));

  return {
    chainId,
    sampledGroups: results.length,
    counts,
    txWeighted: { ...tx, practicePct },
    problems,
    examples,
    warningCodeTotals,
  };
}
