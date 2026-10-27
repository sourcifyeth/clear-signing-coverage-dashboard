/**
 * "Bots & infrastructure": mainnet contracts that no end user signs a
 * transaction to. Bundlers, relayers, MEV searchers, exchange payout wallets,
 * messaging executors, sweepers. A descriptor for such a contract would be
 * shown to nobody, so the dashboard can leave their calls out of the
 * question it answers (`exclude=infra`, off by default in the web app).
 *
 * The list is maintained by hand. Source: the ERC-7730 target study of
 * 2026-10-16 (the 40 busiest mainnet contracts, each read against its source,
 * selector traffic and callers; see the README). To add a contract, append an
 * entry here with a one-line reason and the source; no database change is
 * needed, the API and the follower read this module.
 *
 * The exclusion drops every call to a listed address, whatever its bucket,
 * the way the token exclusion drops every standard selector. Some listed
 * contracts are also unverified on Sourcify: the summary subtracts the
 * overlap once (see windowTotals).
 */

export type InfraKind =
  | "bundler"
  | "operator-wallet"
  | "mev-bot"
  | "relay"
  | "messaging"
  | "automation"
  | "undetermined";

export interface InfraContract {
  /** lowercase 0x address, mainnet */
  address: string;
  name: string;
  kind: InfraKind;
  /** one line: why no end user signs a transaction to this contract */
  reason: string;
  /** where the verdict comes from */
  source: string;
}

export const INFRA_KIND_LABEL: Record<InfraKind, string> = {
  bundler: "ERC-4337 bundler entry point",
  "operator-wallet": "operator-run wallet",
  "mev-bot": "MEV / trading bot",
  relay: "relay or forwarder",
  messaging: "cross-chain messaging infrastructure",
  automation: "automation helper",
  undetermined: "undetermined",
};

const STUDY = "ERC-7730 target study, 2026-10-16";

export const INFRA_CONTRACTS: readonly InfraContract[] = [
  // ---- ERC-4337 entry points: handleOps is signed by bundlers; users sign UserOperations
  {
    address: "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
    name: "ERC-4337 EntryPoint v0.6",
    kind: "bundler",
    reason: "handleOps is signed by bundlers; users sign UserOperations, not transactions to this contract",
    source: STUDY,
  },
  {
    address: "0x0000000071727de22e5e9d8baf0edac6f37da032",
    name: "ERC-4337 EntryPoint v0.7",
    kind: "bundler",
    reason: "handleOps is signed by bundlers; users sign UserOperations, not transactions to this contract",
    source: STUDY,
  },
  {
    address: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
    name: "ERC-4337 EntryPoint v0.8",
    kind: "bundler",
    reason: "handleOps is signed by bundlers; users sign UserOperations, not transactions to this contract",
    source: STUDY,
  },
  // ---- MEV searchers, market makers, trading bots (all unverified)
  {
    address: "0x278d858f05b94576c1e6f73285886876ff6ef8d2",
    name: "MEV searcher bot",
    kind: "mev-bot",
    reason: "unverified; undecodable selectors, zero-value bursts from rotating keys",
    source: STUDY,
  },
  {
    address: "0x51c72848c68a965f66fa7a88855f9f7784502a7f",
    name: "Market maker execution contract",
    kind: "mev-bot",
    reason: "unverified; five of six selectors undecodable, zero-value bursts paying builder tips; 118 senders are the operator's rotating hot keys",
    source: STUDY,
  },
  {
    address: "0x93c30e6e09f698cfea99b09b5166ed90cfaedd17",
    name: "Arbitrage executor",
    kind: "mev-bot",
    reason: "unverified; about 80 undecodable selectors, 51 operator EOAs with nonces of 15k to 87k, no one-shot callers",
    source: STUDY,
  },
  {
    address: "0xdfa8ead9129d2053f307e9370570a33118619ea0",
    name: "Wash-trading wallet farm",
    kind: "mev-bot",
    reason: "unverified 2.6 KB contract faking a swap router; fresh wallets trade two micro-caps with minimum-out zero and pay two fixed collectors",
    source: STUDY,
  },
  {
    address: "0xbdb3ba9ffe392549e1f8658dd2630c141fdf47b6",
    name: "MEV searcher bot",
    kind: "mev-bot",
    reason: "unverified; zero-padded vanity selectors, msg.value equals the block number, about 13 rotating operator wallets",
    source: STUDY,
  },
  {
    address: "0xeff6cb8b614999d130e537751ee99724d01aa167",
    name: "Trading bot executor",
    kind: "mev-bot",
    reason: "unverified 22 KB contract; 119 rotating keys with nonces of 4k to 30k, calldata is a timestamp plus a token address",
    source: STUDY,
  },
  // ---- relays and forwarders
  {
    address: "0xfeeeeee44046c3f61a8cc081e0918ef0de0a7ffc",
    name: "Titan Relay forwarder",
    kind: "relay",
    reason: "unverified; callers are block builders, eight senders in 600 transactions, 'selectors' decode as timestamps",
    source: STUDY,
  },
  {
    address: "0x0000000aa232009084bd71a5797d089aa4edfad4",
    name: "Angstrom (Sorella Labs)",
    kind: "relay",
    reason: "execute(bytes) is callable only by whitelisted nodes once per block with a bundle of many users' orders; users sign EIP-712 orders off-chain",
    source: STUDY,
  },
  // ---- operator-run wallets
  {
    address: "0x2744dfd9898f0babbc570cc594bbbc84b487a22b",
    name: "Circle smart-account instance (payout wallet)",
    kind: "operator-wallet",
    reason: "every execute call comes from one owner EOA with a nonce near 2 million; an automated payout wallet",
    source: STUDY,
  },
  {
    address: "0xee7ae85f2fe2239e27d9c1e23fffe168d63b4055",
    name: "Circle smart-account instance (Binance hot wallet)",
    kind: "operator-wallet",
    reason: "599 of 600 calls from the EOA tagged Binance 14, nonce about 18.7 million; exchange withdrawal automation",
    source: STUDY,
  },
  // ---- cross-chain messaging infrastructure
  {
    address: "0x173272739bd7aa6e4e214714048a9fe699453059",
    name: "LayerZero V2 Executor",
    kind: "messaging",
    reason: "eleven operator keys with nonces of 76k to 3.1 million; users pay the executor through source-chain fees, never by calling it",
    source: STUDY,
  },
  {
    address: "0xc02ab410f0734efa3f14628780e6e695156024c2",
    name: "LayerZero V2 ReceiveUln302",
    kind: "messaging",
    reason: "commitVerification is called only by LayerZero operator keys",
    source: STUDY,
  },
  // ---- automation helpers, sweepers, poisoners
  {
    address: "0xee39678386f5bfc68df2c65656ec8e23f60063b5",
    name: "Token sweeper (verified proxy shell, unverified implementation)",
    kind: "automation",
    reason: "six operator senders pull approved USDC/USDT from 51 EOAs into two collection wallets; deposit sweeping",
    source: STUDY,
  },
  {
    address: "0x00fe78205f5f0e63b8ad2b2ae5337f538a610e04",
    name: "Address-poisoning batcher",
    kind: "automation",
    reason: "executeBatch reverts for anyone but the deployer; all calls come from that EOA; source comments describe an address-poisoning tool",
    source: STUDY,
  },
  {
    address: "0xca11bde05977b3631167028862be2a173976ca11",
    name: "Multicall3",
    kind: "automation",
    reason: "73% of calls come from senders with 10 or more transactions and nonces near 500k; the inner targets are the real descriptor subjects",
    source: STUDY,
  },
  {
    address: "0xe73d53e3a982ab2750a0b76f9012e18b256cc243",
    name: "Token N (first-caller-per-block mint)",
    kind: "automation",
    reason: "mint() pays the first caller in each block; 49 of 50 sampled calls come from two EOAs with nonces of 737k to 1.08 million",
    source: STUDY,
  },
  // ---- undetermined: left out until someone decides
  {
    address: "0x4313c378cc91ea583c91387b9216e2c03096b27f",
    name: "Unidentified swap router (proxy to unverified implementation)",
    kind: "undetermined",
    reason: "owner-controlled multi-DEX router; 200 senders make round ETH buys of memecoins every few minutes, which points to bot-run or custodial wallets",
    source: STUDY,
  },
];

/** lowercase address -> entry */
const BY_ADDRESS: ReadonlyMap<string, InfraContract> = new Map(INFRA_CONTRACTS.map((c) => [c.address.toLowerCase(), c]));

/** The listed addresses, lowercase. */
export const INFRA_ADDRESSES: ReadonlySet<string> = new Set(BY_ADDRESS.keys());

/** SQL literal list of the addresses, for `to_address NOT IN (...)`. */
export const INFRA_ADDRESSES_SQL = [...INFRA_ADDRESSES].map((a) => `'${a}'`).join(",");

/** The entry for an address, or null when it is not listed. */
export function infraOf(address: string | null | undefined): InfraContract | null {
  if (!address) return null;
  return BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

/** What API rows carry for a listed contract (null when not listed). */
export interface InfraTag {
  name: string;
  kind: InfraKind;
  reason: string;
}

export function infraTagOf(address: string | null | undefined): InfraTag | null {
  const c = infraOf(address);
  return c ? { name: c.name, kind: c.kind, reason: c.reason } : null;
}
