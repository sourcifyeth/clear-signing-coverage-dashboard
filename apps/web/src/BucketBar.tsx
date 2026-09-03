import type { Buckets } from "./types.ts";
import { BUCKETS, fmtInt, fmtPct } from "./buckets.ts";

export function BucketBar({ buckets, total, legend = true }: { buckets: Buckets; total: number; legend?: boolean }) {
  return (
    <>
      <div className="bar">
        {BUCKETS.map((bk) => {
          const v = buckets[bk.key];
          const w = total ? (v / total) * 100 : 0;
          if (w <= 0) return null;
          return (
            <div
              key={bk.key}
              className="barSeg"
              style={{ width: `${w}%`, background: bk.color }}
              title={`${bk.label}: ${fmtInt(v)} (${fmtPct(w)})`}
            />
          );
        })}
      </div>
      {legend && (
        <div className="legend">
          {BUCKETS.filter((bk) => buckets[bk.key] > 0).map((bk) => (
            <div key={bk.key} className="legendItem">
              <span className="swatch" style={{ background: bk.color }} />
              {bk.label}
              <span className="muted">
                {" "}
                · {fmtInt(buckets[bk.key])} · {fmtPct(total ? (buckets[bk.key] / total) * 100 : 0)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function Toggle({
  on,
  onClick,
  label,
  swatch,
  disabled,
}: {
  on: boolean;
  onClick?: () => void;
  label: string;
  swatch: string;
  disabled?: boolean;
}) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} onClick={onClick} disabled={disabled}>
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
