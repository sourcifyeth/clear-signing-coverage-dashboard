# Clear-Signing Coverage Dashboard

Measures **what share of Ethereum transactions can be clear-signed** with the
ERC-7730 descriptors in the [clear-signing-erc7730-registry], and shows **which
contracts to add next** to reach 80% / 95% coverage.

"Clear-signable" means: given a transaction's `to` address and its calldata, a
wallet can show a human-readable description instead of raw hex, because a
descriptor exists for that `(address, function)`.

Two levels are measured:

- **In theory** — `(chainId, to, selector)` is present in the registry.
- **In practice** — the Sourcify [`@ethereum-sourcify/clear-signing`][lib]
  library actually produces a display for a real transaction, instead of falling
  back to raw calldata. The gap between the two, with the failure reason, is a
  first-class view.

Weighting is by **transaction count**. Ethereum mainnet only for v1. Transaction
data comes from the Google BigQuery public Ethereum dataset. See the full design
in the plan (kept outside this repo).

[clear-signing-erc7730-registry]: https://github.com/ethereum/clear-signing-erc7730-registry
[lib]: https://github.com/sourcifyeth/clear-signing

## Layout

```
packages/
  coverage/   Stage A — build the (chainId, address, selector) coverage set
              from a local registry checkout.
```

Stages B (BigQuery aggregation), C (practical run), and D (API + React UI) are
not built yet.

## Stage A — build the coverage set

Reads the registry's published `index.calldata.json` (address → descriptor),
resolves each descriptor's `includes`, reads its `display.formats` function
signatures, and computes each 4-byte selector. Output is one row per
`(chainId, address, selector)`.

The include-resolution and selector logic are ported faithfully from the registry
repo (`.github/scripts/resolve-erc7730-includes.js` and
`tools/scripts/check-contract-functions.js`) so this project stays self-contained
and produces identical selectors — see `packages/coverage/src/erc7730.ts`.

### Run

```bash
npm install

# Point --registry at a local checkout of the registry (defaults to the sibling
# ../clear-signing-erc7730-registry). Mainnet only, write the full set to JSON:
npx tsx packages/coverage/src/cli.ts --chains 1 --out out/coverage-mainnet.json

# All chains, stats only (no file):
npx tsx packages/coverage/src/cli.ts --stats
```

Environment: `REGISTRY_PATH` sets the registry checkout path if `--registry` is
omitted.

### Output shape

`out/coverage-mainnet.json` holds `{ registryPath, registryCommit, generatedAtIso,
rows, stats }`, where each row is:

```json
{
  "chainId": 1,
  "address": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  "selector": "0xea598cb0",
  "functionSig": "wrap(uint256 _stETHAmount)",
  "descriptorPath": "registry/lido/calldata-wstETH.json",
  "entity": "lido"
}
```

`standardKind` (`"erc20"` / `"erc721"` / ...) is present only on rows from the
registry's `ercs/` standard descriptors, so the aggregator can label the native
token-transfer bucket.

As of the current registry commit: **1250 mainnet `(address, selector)` rows**
from 172 descriptors, 0 unparsable signatures.

## Requirements

Node >= 20.
