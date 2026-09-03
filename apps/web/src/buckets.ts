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

/** Clear-signable share with the wallet-native buckets toggled in or out. */
export function signablePct(b: Buckets, total: number, countEth: boolean, countToken: boolean): number {
  if (!total) return 0;
  const n = b.covered_theory + (countEth ? b.eth_transfer : 0) + (countToken ? b.token_native : 0);
  return (n / total) * 100;
}
