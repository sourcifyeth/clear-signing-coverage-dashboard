import type { Buckets } from "./types.ts";
import { fmtInt, fmtPct, segments } from "./buckets.ts";

/**
 * Stacked bar of the buckets plus a legend. Pass `unverified` (the part of
 * not_covered whose contract Sourcify knows to be unverified) to split the
 * red slice in two; leave it undefined for the plain five-bucket bar.
 */
export function BucketBar({
  buckets,
  total,
  unverified,
  legend = true,
}: {
  buckets: Buckets;
  total: number;
  unverified?: number;
  legend?: boolean;
}) {
  const segs = segments(buckets, unverified);
  return (
    <>
      <div className="bar">
        {segs.map((s) => {
          const w = total ? (s.value / total) * 100 : 0;
          if (w <= 0) return null;
          return <div key={s.key} className="barSeg" style={{ width: `${w}%`, background: s.color }} title={`${s.label}: ${fmtInt(s.value)} (${fmtPct(w)})`} />;
        })}
      </div>
      {legend && (
        <div className="legend">
          {segs
            .filter((s) => s.value > 0)
            .map((s) => (
              <div key={s.key} className="legendItem">
                <span className="swatch" style={{ background: s.color }} />
                {s.label}
                <span className="muted">
                  {" "}
                  · {fmtInt(s.value)} · {fmtPct(total ? (s.value / total) * 100 : 0)}
                </span>
              </div>
            ))}
          {/* the denominator of every share, at the right edge */}
          <div className="legendItem legendTotal">
            Total txs <span className="muted"> · {fmtInt(total)}</span>
          </div>
        </div>
      )}
    </>
  );
}

export function Toggle({
  on,
  onClick,
  label,
  title,
  swatch,
  disabled,
}: {
  on: boolean;
  onClick?: () => void;
  label: string;
  title?: string;
  swatch: string;
  disabled?: boolean;
}) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} onClick={onClick} disabled={disabled} title={title}>
      <span className="swatch" style={{ background: swatch, opacity: on ? 1 : 0.3 }} />
      {label}
    </button>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="statBox">
      <div className="statVal">{value}</div>
      <div className="statLbl muted">{label}</div>
    </div>
  );
}

export function numOr(n: number | null | undefined) {
  return typeof n === "number" && Number.isFinite(n) ? n : "—";
}
