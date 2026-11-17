import type { ServerConfig } from "./config.js";

/**
 * The app's Solana RPC. Players never see the private RPC's address, which holds its key; they talk to
 * this, and it passes on only the calls the app makes. If the private RPC is busy or down, the call goes to
 * Solana's public one instead, so the app keeps working, just slower.
 */
export const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

export const MAX_BATCH = 20;
const TIMEOUT_MS = 25_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class RpcRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Call {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** How many calls a request makes, for the rate limit; throws if any isn't allowed. */
export function checkCalls(body: unknown): number {
  const calls: Call[] = Array.isArray(body) ? body : [body as Call];
  if (calls.length === 0 || calls.length > MAX_BATCH) throw new RpcRequestError(400, `A batch holds 1 to ${MAX_BATCH} calls.`);
  for (const c of calls) {
    if (typeof c !== "object" || c === null) throw new RpcRequestError(400, "Not a JSON-RPC call.");
    if (typeof c.method !== "string" || !ALLOWED_METHODS.has(c.method)) {
      throw new RpcRequestError(403, `RUGR's RPC doesn't serve ${typeof c.method === "string" ? c.method : "that"}.`);
    }
  }
  return calls.length;
}

export class RpcRelay {
  constructor(
    private cfg: Pick<ServerConfig, "rpcUrl" | "publicRpcUrl">,
    private log: (m: string) => void = () => undefined,
    private fetchImpl: FetchLike = fetch,
  ) {}

  /** Answers a checked request: the private RPC's answer, or the public one's when the private one fails. */
  async relay(body: unknown): Promise<{ status: number; text: string }> {
    const payload = JSON.stringify(body);
    const sends = (Array.isArray(body) ? body : [body]).some((c: Call) => c.method === "sendTransaction");
    const primary = await this.post(this.cfg.rpcUrl, payload);
    if (primary && primary.status < 500 && primary.status !== 429) {
      // A transaction also goes out the public way. It's the same signed transaction, so it can only land
      // once, and a second route makes it likelier to land at all.
      if (sends && this.cfg.publicRpcUrl !== this.cfg.rpcUrl) void this.post(this.cfg.publicRpcUrl, payload);
      return primary;
    }
    if (this.cfg.publicRpcUrl === this.cfg.rpcUrl) return primary ?? { status: 502, text: rpcError(-32000, "The RPC can't be reached.") };
    this.log(`private RPC ${primary ? `answered ${primary.status}` : "failed"}; using the public one`);
    const fallback = await this.post(this.cfg.publicRpcUrl, payload);
    return fallback ?? { status: 502, text: rpcError(-32000, "The RPC can't be reached.") };
  }

  private async post(url: string, payload: string): Promise<{ status: number; text: string } | null> {
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    } catch {
      return null;
    }
  }
}

export function rpcError(code: number, message: string, id: unknown = null): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
