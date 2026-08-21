/**
 * Build the RegistryIndex the Sourcify library expects from a local registry
 * checkout. The registry already publishes the two files in exactly the shape
 * the library's RegistryIndex needs:
 *   index.calldata.json -> calldataIndex  (caip10 -> descriptor path)
 *   index.eip712.json   -> typedDataIndex (caip10 -> primaryType -> entries)
 *
 * Paths are stored full and relative to the repo root (e.g.
 * "registry/lido/calldata-wstETH.json"), so with descriptorDirectory set to the
 * repo root the library resolves each descriptor's `includes` chain correctly,
 * including `../../ercs/*.json` traversals.
 */

import fs from "node:fs";
import path from "node:path";
import type { RegistryIndex } from "@ethereum-sourcify/clear-signing";

export function loadRegistryIndex(registryPath: string): RegistryIndex {
  const calldataPath = path.join(registryPath, "index.calldata.json");
  const eip712Path = path.join(registryPath, "index.eip712.json");

  const calldataIndex = JSON.parse(fs.readFileSync(calldataPath, "utf8")) as RegistryIndex["calldataIndex"];
  const typedDataIndex = fs.existsSync(eip712Path)
    ? (JSON.parse(fs.readFileSync(eip712Path, "utf8")) as RegistryIndex["typedDataIndex"])
    : {};

  return { calldataIndex, typedDataIndex };
}
