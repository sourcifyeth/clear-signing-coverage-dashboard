/**
 * The standard ERC-20 / ERC-721 transfer and approval selectors. Wallets show
 * these natively from token metadata, so the dashboard can exclude them from
 * the statistics and the ticker regardless of whether the token also has a
 * registry descriptor.
 */
export const STANDARD_TOKEN_SELECTORS: ReadonlySet<string> = new Set<string>([
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x095ea7b3", // approve(address,uint256)
  "0x39509351", // increaseAllowance(address,uint256)
  "0xa457c2d7", // decreaseAllowance(address,uint256)
  "0x42842e0e", // safeTransferFrom(address,address,uint256)
  "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  "0xa22cb465", // setApprovalForAll(address,bool)
]);

/** SQL literal list of the standard token selectors, for `selector NOT IN (...)`. */
export const STANDARD_TOKEN_SELECTORS_SQL = [...STANDARD_TOKEN_SELECTORS].map((s) => `'${s}'`).join(",");

/** The live tables are single-chain (mainnet); the contracts cache is keyed by chain. */
export const LIVE_CHAIN_ID = 1;

/** Which transaction kinds to leave out of a query (numerator and denominator alike). */
export interface ExcludeOptions {
  /** drop plain ETH sends (empty calldata) */
  excludeEth?: boolean;
  /** drop every call whose selector is a standard token transfer/approval, covered or not */
  excludeToken?: boolean;
  /**
   * drop not-covered calls whose target contract Sourcify knows to be
   * unverified (no source, so no descriptor can ever be written). Contracts
   * the cache has not classified stay in. Covered and wallet-native calls are
   * never affected.
   */
  excludeUnverified?: boolean;
}

/** Extra `AND ...` clauses for an `ExcludeOptions`, against columns `bucket`, `selector` and `to_address`. */
export function excludeSql(opts: ExcludeOptions | undefined, alias = ""): string {
  const p = alias ? `${alias}.` : "";
  let sql = "";
  if (opts?.excludeEth) sql += ` AND ${p}bucket != 'eth_transfer'`;
  if (opts?.excludeToken) sql += ` AND ${p}selector NOT IN (${STANDARD_TOKEN_SELECTORS_SQL})`;
  if (opts?.excludeUnverified) sql += ` AND NOT (${p}bucket = 'not_covered' AND ${unverifiedExistsSql(`${p}to_address`)})`;
  return sql;
}

/** `EXISTS (...)`: the address has a contracts row with verified = 0. */
export function unverifiedExistsSql(addressExpr: string): string {
  return `EXISTS (SELECT 1 FROM contracts k WHERE k.chain_id = ${LIVE_CHAIN_ID} AND k.address = ${addressExpr} AND k.verified = 0)`;
}
