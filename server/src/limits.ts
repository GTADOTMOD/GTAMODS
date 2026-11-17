/**
 * How much each player can ask for, so nobody can use this server as a free RPC or fill its disk.
 * A bucket per player refills at a steady rate and can hold a burst.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private perSecond: number,
    private burst: number,
    private now: () => number = Date.now,
  ) {
    const sweep = setInterval(() => this.sweep(), 60_000);
    sweep.unref();
  }

  /** True if this player may make `cost` more requests now, and takes them. */
  take(key: string, cost = 1): boolean {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** Full buckets are the same as no bucket, so they're dropped to keep memory flat. */
  private sweep(): void {
    const now = this.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.perSecond >= this.burst) this.buckets.delete(key);
    }
  }
}

/**
 * The player's address. Render sits behind Cloudflare, which sets its own header and overwrites any copy a
 * client sends. Without it, the last address in X-Forwarded-For is the one the proxy added, which a client
 * can't fake; the first can be anything.
 */
export function clientKey(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const cf = one(headers["cf-connecting-ip"]);
  if (cf) return cf.trim();
  const forwarded = one(headers["x-forwarded-for"]);
  if (forwarded) return forwarded.split(",").at(-1)!.trim();
  return socketAddress ?? "unknown";
}
