/**
 * Names, logos and prices for Solana tokens, from Jupiter's public token API. It only makes the screens fuller: if it can't be reached the app
 * carries on without it, and nothing to do with a trade's limits comes from here.
 */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Offered when picking a token. Their decimals never change, so no lookup is needed. */
export const POPULAR_TOKENS: Record<string, { symbol: string; name: string; decimals: number }> = {
  [USDC_MINT]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD", decimals: 6 },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter", decimals: 6 },
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: { symbol: "PUMP", name: "Pump", decimals: 6 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk", decimals: 5 },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat", decimals: 6 },
};

const API = "https://api.jup.ag/tokens/v2";
const SEARCH_URL = `${API}/search`;
const FRESH_FOR_MS = 60_000;
const BUSY_PAUSE_MS = 15_000; // with no key, Jupiter allows about 5 requests every 10 seconds
const MAX_PER_REQUEST = 50;

export interface TokenInfo {
  symbol?: string;
  name?: string;
  logo?: string;
  verified: boolean;
  usdPrice?: number;
  change24hPct?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  holders?: number;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const httpsOnly = (v: unknown): string | undefined => (typeof v === "string" && v.startsWith("https://") ? v : undefined);

function parseInfo(t: Json): TokenInfo {
  const day = (t.stats24h ?? {}) as Json;
  return {
    symbol: str(t.symbol),
    name: str(t.name),
    logo: httpsOnly(t.icon),
    verified: t.isVerified === true,
    usdPrice: num(t.usdPrice),
    change24hPct: num(day.priceChange),
    volume24hUsd: (num(day.buyVolume) ?? 0) + (num(day.sellVolume) ?? 0) || undefined,
    liquidityUsd: num(t.liquidity),
    marketCapUsd: num(t.mcap),
    holders: num(t.holderCount),
  };
}

export class TokenDirectory {
  private cache = new Map<string, { at: number; info: TokenInfo }>();
  private pausedUntil = 0;

  constructor(
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  /** What's known about these tokens. Ones Jupiter doesn't know, or can't say right now, are left out. */
  async lookup(mints: string[]): Promise<Map<string, TokenInfo>> {
    const missing = mints.filter((m) => {
      const hit = this.cache.get(m);
      return !hit || this.now() - hit.at > FRESH_FOR_MS;
    });
    for (let i = 0; i < missing.length; i += MAX_PER_REQUEST) {
      const url = new URL(SEARCH_URL);
      url.searchParams.set("query", missing.slice(i, i + MAX_PER_REQUEST).join(","));
      await this.fetchTokens(url);
    }
    const out = new Map<string, TokenInfo>();
    for (const m of mints) {
      const hit = this.cache.get(m);
      if (hit) out.set(m, hit.info);
    }
    return out;
  }

  /** Null if it can't be had right now, for any reason. */
  private async fetchTokens(url: URL): Promise<Json[] | null> {
    if (this.now() < this.pausedUntil) return null;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
      if (res.status === 429) this.pausedUntil = this.now() + BUSY_PAUSE_MS;
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return null;
      const tokens = body as Json[];
      for (const t of tokens) {
        if (typeof t.id === "string") this.cache.set(t.id, { at: this.now(), info: parseInfo(t) });
      }
      return tokens;
    } catch {
      return null;
    }
  }
}
