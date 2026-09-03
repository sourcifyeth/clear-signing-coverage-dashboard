import type { BucketKey, Buckets, LiveStatus } from "./types.ts";

export const BUCKETS: { key: BucketKey; label: string; color: string }[] = [
  { key: "covered_theory", label: "Covered by descriptor", color: "#4ade80" },
  { key: "eth_transfer", label: "ETH transfer", color: "#38bdf8" },
  { key: "token_native", label: "Token transfer / approve", color: "#818cf8" },
  { key: "not_covered", label: "Not covered", color: "#f87171" },
  { key: "contract_creation", label: "Contract creation", color: "#64748b" },
];

export const BUCKET_COLOR: Record<BucketKey, string> = Object.fromEntries(
  BUCKETS.map((b) => [b.key, b.color]),
) as Record<BucketKey, string>;

export const STATUS_COLOR: Record<LiveStatus, string> = {
  pass: "#4ade80",
  partial: "#eab308",
  failed: "#f87171",
};

export const fmtInt = (n: number) => n.toLocaleString("en-US");
export const fmtPct = (n: number) => `${n.toFixed(1)}%`;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Clear-signable share. A wallet-native bucket that is toggled off is left out
 * of the denominator as well, so "off" means "not part of the question", not
 * "counted as unsignable".
 */
export function signablePct(b: Buckets, total: number, countEth: boolean, countToken: boolean): number {
  const denom = total - (countEth ? 0 : b.eth_transfer) - (countToken ? 0 : b.token_native);
  if (denom <= 0) return 0;
  const n = b.covered_theory + (countEth ? b.eth_transfer : 0) + (countToken ? b.token_native : 0);
  return (n / denom) * 100;
}

/** Standard ERC-20/721 transfer and approval selectors (mirror of @ccd/db). */
export const STANDARD_TOKEN_SELECTORS = new Set<string>([
  "0xa9059cbb",
  "0x23b872dd",
  "0x095ea7b3",
  "0x39509351",
  "0xa457c2d7",
  "0x42842e0e",
  "0xb88d4fde",
  "0xa22cb465",
]);

/** `?exclude=` value for the API from the two toggles ("" when nothing is excluded). */
export function excludeParam(countEth: boolean, countToken: boolean): string {
  const parts = [!countEth && "eth", !countToken && "token"].filter(Boolean);
  return parts.length ? `&exclude=${parts.join(",")}` : "";
}
