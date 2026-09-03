/**
 * Minimal JSON-RPC client for the block follower. Node 20 global fetch, no
 * extra dependency. The endpoint URL may embed an API key, so it is never
 * logged; `describeRpc()` returns a safe label instead.
 */

export interface RpcConfig {
  url: string;
  /** safe, key-free label for logs */
  label: string;
}

/**
 * Resolve the RPC endpoint from the environment:
 *   RPC_URL         explicit endpoint (may contain a key; never logged)
 *   DRPC_API_KEY    -> https://lb.drpc.org/ethereum/<key>
 *   (else)          public fallback
 */
export function rpcFromEnv(env: NodeJS.ProcessEnv = process.env): RpcConfig {
  if (env.RPC_URL) return { url: env.RPC_URL, label: "custom RPC_URL" };
  if (env.DRPC_API_KEY) return { url: `https://lb.drpc.org/ethereum/${env.DRPC_API_KEY}`, label: "drpc (ethereum)" };
  return { url: "https://ethereum-rpc.publicnode.com", label: "publicnode (public fallback)" };
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type BatchResult = { result: unknown; error?: undefined } | { result?: undefined; error: string };

export interface RpcTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string; // hex quantity
  transactionIndex: string;
}

export interface RpcBlock<T = RpcTx> {
  number: string; // hex
  hash: string;
  parentHash: string;
  timestamp: string; // hex seconds
  transactions: T[];
}

export function makeRpc(cfg: RpcConfig, opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let nextId = 1;

  async function post(payload: unknown, ms: number): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new RpcError(`HTTP ${res.status} from RPC (${cfg.label})`, undefined, res.status);
      return await res.json();
    } catch (e) {
      if (e instanceof RpcError) throw e;
      const msg = (e as Error).name === "AbortError" ? `RPC timeout after ${ms}ms` : (e as Error).message;
      throw new RpcError(`${msg} (${cfg.label})`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(method: string, params: unknown[], callOpts: { timeoutMs?: number } = {}): Promise<T> {
    const body = (await post({ jsonrpc: "2.0", id: nextId++, method, params }, callOpts.timeoutMs ?? timeoutMs)) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (body.error) throw new RpcError(`RPC error ${body.error.code}: ${body.error.message}`, body.error.code);
    return body.result as T;
  }

  /**
   * JSON-RPC batch: one HTTP request, one result slot per call. A call that
   * the node rejects (revert, bad address) gives `{ error }` in its slot
   * instead of throwing, so the caller can keep the good ones. Falls back to
   * sequential calls when the endpoint does not answer with an array.
   */
  async function batch(calls: { method: string; params: unknown[] }[], callOpts: { timeoutMs?: number } = {}): Promise<BatchResult[]> {
    if (calls.length === 0) return [];
    const ms = callOpts.timeoutMs ?? timeoutMs;
    const ids = calls.map(() => nextId++);
    const payload = calls.map((c, i) => ({ jsonrpc: "2.0", id: ids[i], method: c.method, params: c.params }));
    const res = await post(payload, ms);
    if (Array.isArray(res)) {
      const byId = new Map<number, { result?: unknown; error?: { code: number; message: string } }>();
      for (const r of res as { id: number; result?: unknown; error?: { code: number; message: string } }[]) byId.set(r.id, r);
      return ids.map((id) => {
        const r = byId.get(id);
        if (!r) return { error: "missing from batch response" };
        if (r.error) return { error: r.error.message };
        return { result: r.result };
      });
    }
    // Endpoint does not support batches: one request per call.
    const out: BatchResult[] = [];
    for (const c of calls) {
      try {
        out.push({ result: await call<unknown>(c.method, c.params, { timeoutMs: ms }) });
      } catch (e) {
        if (e instanceof RpcError && e.status !== undefined) throw e; // transport-level: give up
        out.push({ error: (e as Error).message });
      }
    }
    return out;
  }

  return {
    label: cfg.label,
    call,
    batch,
    /** eth_call against the latest block; returns the hex return data. */
    ethCall: (to: string, data: string, callOpts: { timeoutMs?: number } = {}): Promise<string> =>
      call<string>("eth_call", [{ to, data }, "latest"], callOpts),
    blockNumber: async (): Promise<number> => Number(await call<string>("eth_blockNumber", [])),
    /** Full block with transaction objects; null if the node does not have it yet. */
    blockWithTxs: (n: number): Promise<RpcBlock | null> =>
      call<RpcBlock | null>("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]),
    /** Header only (transactions as hashes). */
    blockHeader: (n: number, callOpts: { timeoutMs?: number } = {}): Promise<RpcBlock<string> | null> =>
      call<RpcBlock<string> | null>("eth_getBlockByNumber", [`0x${n.toString(16)}`, false], callOpts),
  };
}

export type Rpc = ReturnType<typeof makeRpc>;
