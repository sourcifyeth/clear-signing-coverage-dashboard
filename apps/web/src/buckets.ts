import type { BucketKey, Buckets, LiveStatus } from "./types.ts";

// Sourcify palette: green = covered / clear-signable, light coral = not
// covered, cerulean blues for the wallet-native kinds (token calls, ETH sends).
export const BUCKETS: { key: BucketKey; label: string; color: string }[] = [
  { key: "covered_theory", label: "Covered by descriptor", color: "#4ade80" },
  { key: "eth_transfer", label: "ETH transfer", color: "#a9bdee" },
  { key: "token_native", label: "Token transfer / approve", color: "#7693da" },
  { key: "not_covered", label: "Not covered", color: "#ff858d" },
  { key: "contract_creation", label: "Contract creation", color: "#9ca3af" },
];

export const COLOR = {
  ok: "#4ade80",
  okText: "#16a34a",
  no: "#ff858d",
  noText: "#ae373f",
  /** not covered AND unverified on Sourcify: a deeper coral (ΔE 16.5 from `no`, CVD-safe) */
  noUnverified: "#c4535b",
  token: "#7693da",
  eth: "#a9bdee",
} as const;

/** One slice of the bucket bar / legend. */
export interface Segment {
  key: string;
  label: string;
  color: string;
  value: number;
}

/**
 * The bar's slices in order. "Not covered" is split by Sourcify verification
 * when the API reports the unverified part: verified contracts first (a
 * descriptor can be written), then unverified ones (no ABI to build on).
 * Contracts not yet checked count as verified, so the unverified slice is a
 * lower bound. The denominator does not change.
 */
export function segments(b: Buckets, notCoveredUnverified?: number): Segment[] {
  const unv = Math.max(0, Math.min(notCoveredUnverified ?? 0, b.not_covered));
  const split = notCoveredUnverified !== undefined;
  return [
    { key: "covered_theory", label: "Covered by descriptor", color: BUCKET_COLOR.covered_theory, value: b.covered_theory },
    { key: "eth_transfer", label: "ETH transfer", color: BUCKET_COLOR.eth_transfer, value: b.eth_transfer },
    { key: "token_native", label: "Token transfer / approve", color: BUCKET_COLOR.token_native, value: b.token_native },
    {
      key: "not_covered",
      label: split ? "Not covered (verified)" : "Not covered",
      color: COLOR.no,
      value: b.not_covered - unv,
    },
    ...(split ? [{ key: "not_covered_unverified", label: "Not covered (unverified)", color: COLOR.noUnverified, value: unv }] : []),
    { key: "contract_creation", label: "Contract creation", color: BUCKET_COLOR.contract_creation, value: b.contract_creation },
  ];
}

export const BUCKET_COLOR: Record<BucketKey, string> = Object.fromEntries(
  BUCKETS.map((b) => [b.key, b.color]),
) as Record<BucketKey, string>;

export const STATUS_COLOR: Record<LiveStatus, string> = {
  pass: "#2b50aa",
  partial: "#d97706",
  failed: "#ae373f",
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
