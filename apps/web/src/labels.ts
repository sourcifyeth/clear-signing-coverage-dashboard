// Static, best-effort labels for well-known mainnet contracts, so the ranked
// "to build" list is readable. Not authoritative — purely a display hint.
// Keys are lowercased addresses.

export const KNOWN_LABELS: Record<string, string> = {
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router 2",
  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af": "Uniswap Universal Router",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router (old)",
  "0xc36442b4a4522e871399cd717abdd847ab11fe88": "Uniswap V3 Positions NFT",
  "0x881d40237659c251811cec9c364ef91dc08d300c": "MetaMask Swap Router",
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": "LI.FI Diamond",
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  "0x9008d19f58aabd9ed0d60971565aa8510560ab41": "CoW Protocol Settlement",
  "0x0000000000000068f116a894984e2db1123eb395": "Seaport 1.6 (OpenSea)",
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "Seaport 1.5 (OpenSea)",
  "0x000000000000ad05ccc4f10045630fb830b95127": "Blur Marketplace",
  "0x3328f7f4a1d1c57c35df56bbf0c9dcafca309c49": "Banana Gun Router",
  "0x51c72848c68a965f66fa7a88855f9f7784502a7f": "Maestro Router",
  "0xd3bede0d95ff696c3545c2802b1b7f0f97b8f264": "Across / relayer",
};

export function labelFor(address: string): string | null {
  return KNOWN_LABELS[address.toLowerCase()] ?? null;
}
