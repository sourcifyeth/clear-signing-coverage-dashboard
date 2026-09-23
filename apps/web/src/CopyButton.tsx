import { useState } from "react";

/** Copies `text` to the clipboard; shows a check for a moment after. Stops the click from reaching the row. */
export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      /* clipboard blocked (insecure context or permission); nothing to do */
    }
  };
  return (
    <button type="button" className={`copyBtn ${done ? "done" : ""}`} onClick={copy} data-tip={done ? "Copied" : "Copy hash"} aria-label="Copy transaction hash">
      {done ? "✓" : "⧉"}
    </button>
  );
}
