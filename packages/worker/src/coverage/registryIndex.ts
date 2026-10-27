/**
 * Build the RegistryIndex the Sourcify library expects from a local registry
 * checkout, in the shape of the registry's two index files:
 *   calldataIndex  (caip10 -> descriptor path)
 *   typedDataIndex (caip10 -> primaryType -> entries)
 *
 * The committed index.calldata.json / index.eip712.json are not read: the
 * registry refreshes them through a chore pull request and they lag the
 * descriptors by days. Both indexes are generated from the descriptor files
 * (see @ccd/coverage generateIndexes), the same way the registry's own
 * generator does, so the library renders every descriptor at the checked-out
 * commit.
 *
 * Paths are repo-relative (e.g. "registry/lido/calldata-wstETH.json"), so with
 * descriptorDirectory set to the repo root the library resolves each
 * descriptor's `includes` chain correctly, including `../../ercs/*.json`.
 */

import type { RegistryIndex } from "@ethereum-sourcify/clear-signing";
import { generateIndexes } from "@ccd/coverage";

export function loadRegistryIndex(registryPath: string): RegistryIndex {
  const g = generateIndexes(registryPath);
  return {
    calldataIndex: g.calldata as RegistryIndex["calldataIndex"],
    typedDataIndex: g.eip712 as unknown as RegistryIndex["typedDataIndex"],
  };
}
