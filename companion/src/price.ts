import { Connection, PublicKey } from "@solana/web3.js";

/** Pyth's SOL/USD price account, read from the chain like every other number. */
export const SOL_USD_ACCOUNT = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
export const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const CACHE_MS = 30_000;
const MAX_AGE_SECONDS = 300;

/**
 * Pyth's PriceUpdateV2: discriminator(8) write_authority(32) verification(1,
 * or 2 when partial), then feed_id(32) price(i64) conf(u64) exponent(i32)
 * publish_time(i64). Returns null for anything that isn't a fresh SOL price, so
 * the phone falls back to showing SOL instead of a wrong dollar figure.
 */
export function decodeSolPrice(data: Buffer, nowMs: number): number | null {
  try {
    const offset = data[40] === 1 ? 41 : 42;
    if (data.subarray(offset, offset + 32).toString("hex") !== SOL_USD_FEED_ID) return null;
    const price = Number(data.readBigInt64LE(offset + 32));
    const exponent = data.readInt32LE(offset + 48);
    const publishedSeconds = Number(data.readBigInt64LE(offset + 52));
    if (nowMs / 1000 - publishedSeconds > MAX_AGE_SECONDS) return null;
    const usd = price * 10 ** exponent;
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

/**
 * Dollar values are for display only: every trade is quoted and limited in SOL.
 */
export class SolPrice {
  private usd: number | null = null;
  private fetchedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(
    private connection: Connection,
    private now: () => number = Date.now,
  ) {}

  /** The price now, if known. Refreshes in the background when old. */
  peek(): number | null {
    if (this.isStale()) void this.refresh();
    return this.usd;
  }

  async get(): Promise<number | null> {
    if (this.isStale()) await this.refresh();
    return this.usd;
  }

  private isStale(): boolean {
    return this.now() - this.fetchedAt > CACHE_MS;
  }

  private refresh(): Promise<void> {
    this.pending ??= this.connection
      .getAccountInfo(SOL_USD_ACCOUNT)
      .then((info) => {
        this.usd = info ? decodeSolPrice(info.data, this.now()) : null;
      })
      .catch(() => {
        this.usd = null;
      })
      .finally(() => {
        this.fetchedAt = this.now();
        this.pending = null;
      });
    return this.pending;
  }
}
