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

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new RpcError(`HTTP ${res.status} from RPC (${cfg.label})`, undefined, res.status);
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new RpcError(`RPC error ${body.error.code}: ${body.error.message}`, body.error.code);
      return body.result as T;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      const msg = (e as Error).name === "AbortError" ? `RPC timeout after ${timeoutMs}ms` : (e as Error).message;
      throw new RpcError(`${msg} (${cfg.label})`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    label: cfg.label,
    call,
    blockNumber: async (): Promise<number> => Number(await call<string>("eth_blockNumber", [])),
    /** Full block with transaction objects; null if the node does not have it yet. */
    blockWithTxs: (n: number): Promise<RpcBlock | null> =>
      call<RpcBlock | null>("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]),
    /** Header only (transactions as hashes). */
    blockHeader: (n: number): Promise<RpcBlock<string> | null> =>
      call<RpcBlock<string> | null>("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]),
  };
}

export type Rpc = ReturnType<typeof makeRpc>;
