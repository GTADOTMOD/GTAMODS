import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { Global, OnlinePumpSdk, PUMP_SDK, bondingCurveMarketCap, bondingCurvePda, isBondingCurveMigrated } from "@pump-fun/pump-sdk";
import type { Network } from "./config.js";
import type { Coin, Store } from "./store.js";

/** A RUGR coin as the phone's Trending and New lists show it. */
export interface BoardCoin {
  mint: string;
  name: string;
  symbol: string;
  image?: string;
  createdMs: number;
  marketCapUsd?: number;
  marketCapSol?: number;
  /** Over the last 5 minutes. */
  changePct?: number;
  volumeUsd?: number;
  /** Wallets trading it in the last 5 minutes. */
  traders?: number;
  holders?: number;
  /** Bonding-curve progress, 0-100; absent once it's graduated. */
  progressPct?: number;
  graduated?: boolean;
}

export type ListKind = "trending" | "new";

export const LIST_SIZE = 25;
const WATCHED = 300; // the newest this many get fresh stats; older ones keep their last
const JUPITER_SEARCH = "https://api.jup.ag/tokens/v2/search";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const PER_SEARCH = 50;
const SEARCH_GAP_MS = 2_200; // Jupiter allows about one request every 2 seconds without a key
const LAMPORTS_PER_SOL = 1_000_000_000;

interface Stats {
  marketCapUsd?: number;
  marketCapSol?: number;
  changePct?: number;
  volumeUsd?: number;
  traders?: number;
  holders?: number;
  progressPct?: number;
  graduated?: boolean;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Trending and New, from the coins launched through RUGR only. Their stats come from two places: Jupiter's
 * token data (market cap, 5-minute change, volume, traders, holders), and each coin's bonding curve on-chain,
 * which is there from the first second and is all there is on devnet.
 */
export class CoinBoard {
  private stats = new Map<string, Stats>();
  private solUsd: number | undefined;
  private global: Global | null = null;
  private refreshing = false;

  constructor(
    private connection: Connection,
    private store: Store,
    private network: Network,
    private jupiterKey = "",
    private log: (m: string) => void = () => undefined,
    private fetchImpl: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  list(kind: ListKind): BoardCoin[] {
    const coins = this.store.allCoins().map((c) => this.board(c));
    if (kind === "new") return coins.sort((a, b) => b.createdMs - a.createdMs).slice(0, LIST_SIZE);
    const cap = (c: BoardCoin) => c.marketCapUsd ?? (c.marketCapSol !== undefined && this.solUsd ? c.marketCapSol * this.solUsd : c.marketCapSol ?? 0);
    return coins
      .sort((a, b) => (b.traders ?? 0) - (a.traders ?? 0) || (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0) || cap(b) - cap(a) || b.createdMs - a.createdMs)
      .slice(0, LIST_SIZE);
  }

  private board(c: Coin): BoardCoin {
    const s = this.stats.get(c.mint) ?? {};
    const marketCapUsd = s.marketCapUsd ?? (s.marketCapSol !== undefined && this.solUsd ? s.marketCapSol * this.solUsd : undefined);
    return { mint: c.mint, name: c.name, symbol: c.symbol, image: c.image, createdMs: c.createdMs, ...s, marketCapUsd };
  }

  /** Brings every watched coin's stats up to date. Safe to call on a timer; overlapping calls are skipped. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const watched = this.store.allCoins().sort((a, b) => b.createdMs - a.createdMs).slice(0, WATCHED).map((c) => c.mint);
      if (watched.length === 0) return;
      await this.readCurves(watched).catch((e) => this.log(`curves: ${(e as Error).message}`));
      if (this.network === "mainnet") await this.readJupiter(watched).catch((e) => this.log(`jupiter: ${(e as Error).message}`));
    } finally {
      this.refreshing = false;
    }
  }

  private async readCurves(mints: string[]): Promise<void> {
    this.global ??= await new OnlinePumpSdk(this.connection).fetchGlobal();
    const initial = this.global.initialRealTokenReserves;
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100);
      const infos = await this.connection.getMultipleAccountsInfo(chunk.map((m) => bondingCurvePda(new PublicKey(m))));
      infos.forEach((info, n) => {
        if (!info) return;
        const curve = PUMP_SDK.decodeBondingCurve(info);
        const s = this.stats.get(chunk[n]) ?? {};
        if (curve.complete || isBondingCurveMigrated(curve)) {
          s.graduated = true;
          s.progressPct = undefined;
        } else {
          const sold = initial.sub(BN.min(initial, curve.realTokenReserves));
          s.progressPct = initial.isZero() ? 0 : Math.min(100, Number(sold.muln(10_000).div(initial).toString()) / 100);
          const mc = bondingCurveMarketCap({ mintSupply: curve.tokenTotalSupply, virtualQuoteReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves });
          s.marketCapSol = Number(mc.toString()) / LAMPORTS_PER_SOL;
        }
        this.stats.set(chunk[n], s);
      });
    }
  }

  private async readJupiter(mints: string[]): Promise<void> {
    const ask = [SOL_MINT, ...mints];
    for (let i = 0; i < ask.length; i += PER_SEARCH) {
      if (i > 0) await this.sleep(SEARCH_GAP_MS);
      const url = new URL(JUPITER_SEARCH);
      url.searchParams.set("query", ask.slice(i, i + PER_SEARCH).join(","));
      const res = await this.fetchImpl(url, {
        headers: this.jupiterKey ? { "x-api-key": this.jupiterKey } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Jupiter answered ${res.status}`);
      const tokens = (await res.json()) as unknown;
      if (!Array.isArray(tokens)) throw new Error("Jupiter sent no list");
      for (const t of tokens as Json[]) {
        if (typeof t.id !== "string") continue;
        if (t.id === SOL_MINT) {
          this.solUsd = num(t.usdPrice) ?? this.solUsd;
          continue;
        }
        const five = (t.stats5m ?? {}) as Json;
        const s = this.stats.get(t.id) ?? {};
        s.marketCapUsd = num(t.mcap) ?? s.marketCapUsd;
        s.changePct = num(five.priceChange);
        s.volumeUsd = (num(five.buyVolume) ?? 0) + (num(five.sellVolume) ?? 0) || undefined;
        s.traders = num(five.numTraders);
        s.holders = num(t.holderCount) ?? s.holders;
        if (t.graduatedPool) s.graduated = true;
        this.stats.set(t.id, s);
      }
    }
  }
}
