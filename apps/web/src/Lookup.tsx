import { useState } from "react";
import { parseLookup, type Route } from "./route.ts";

/**
 * Paste a transaction hash (kind "tx") or a block number (kind "block") and
 * open the matching modal. An explorer URL that holds one also works. The
 * modal says when the item is outside the 7-day live index.
 */
export function Lookup({ kind, onOpen }: { kind: "tx" | "block"; onOpen: (r: Route) => void }) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = parseLookup(text);
    const ok = r && (kind === "tx" ? r.tx !== null : r.block !== null);
    if (!ok) {
      setBad(true);
      return;
    }
    setBad(false);
    setText("");
    onOpen(r);
  };
  const placeholder = kind === "tx" ? "Tx hash" : "Block number";
  return (
    <form
      className={`lookup ${bad ? "bad" : ""}`}
      onSubmit={submit}
      title={kind === "tx" ? "Open a transaction in the details view" : "Open a block in the details view"}
    >
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          if (bad) setBad(false);
        }}
      />
      <button type="submit" disabled={!text.trim()}>
        Open
      </button>
    </form>
  );
}
