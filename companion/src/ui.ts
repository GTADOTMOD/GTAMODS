import BN from "bn.js";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { Config } from "./config.js";
import {
  fmtAge,
  fmtCompact,
  fmtMoney,
  fmtMoneyChange,
  fmtPercent,
  fmtPercentChange,
  fmtSol,
  fmtUsd,
  lamportsToSol,
  phoneText,
  rawToUi,
  shortAddr,
  solToLamports,
  ticker,
} from "./format.js";
import { latestImage, resolveImage } from "./images.js";
import { Jupiter, SwapOrder, checkSwap, signSwap } from "./jupiter.js";
import { MetaResolver } from "./metadata.js";
import { SolPrice } from "./price.js";
import { BuyQuote, NotOnPumpError, PumpEngine, SellQuote, TokenState } from "./pump.js";
import { MetadataInput, RugrApi } from "./rugr.js";
import { BuiltTx, UserError, buildTx, parsePublicKey, sendAndConfirm, simulate } from "./solana.js";
import { History, QuoteStore, Watchlist } from "./store.js";
import { POPULAR_TOKENS, SOL_MINT, TokenDirectory, TokenInfo, USDC_MINT } from "./tokens.js";

/*
 * Server-driven UI. The GTA mod is a thin renderer: it shows the rows of a
 * Screen on the phone and, when the player picks one, performs its Action.
 * All decisions (what to show, what is allowed, what a trade costs) live
 * here, where they can be tested without the game.
 */

/** Row icons, by the ids the phone's Scaleform movie uses (iFruit Jailbreak's PhoneIcon). */
export const Icon = {
  None: 0,
  Camera: 1,
  Email: 4,
  EyeFind: 6,
  Attachment: 10,
  Bawsaq: 13,
  Settings: 23,
  Profile: 25,
  History: 31,
  Checklist: 39,
  AddTag: 44,
  RemoveTag: 45,
  Party: 47,
  Ticked: 48,
  Broadcast: 49,
  Lock: 54,
} as const;

export type Action =
  /** GET a screen and push it. */
  | { kind: "open"; path: string }
  /** POST, then follow the response's nav. `quiet` leaves the screen up in the meantime. */
  | { kind: "post"; path: string; body?: Record<string, unknown>; quiet?: boolean }
  /** Show the on-screen keyboard, then POST { ...body, [field]: text }. */
  | { kind: "input"; title: string; maxLength: number; initial?: string; path: string; field: string; body?: Record<string, unknown> }
  /** Ask for a password, hiding what's typed, then POST { ...body, [field]: text } exactly as typed. */
  | { kind: "secret"; title: string; hint: string; maxLength: number; path: string; field: string; body?: Record<string, unknown> }
  /** Save a screenshot into the images folder, then POST { ...body, [field]: fileName }. */
  | { kind: "photo"; path: string; field: string; body?: Record<string, unknown> }
  | { kind: "refresh" }
  /** Switch to one of the bottom tabs, or another screen at the top of its stack. */
  | { kind: "tab"; path: string }
  | { kind: "back" }
  | { kind: "home" }
  | { kind: "close" };

/** How a row looks in the themed app (the simulator and the in-game panel).
 * `text` always says the whole thing, because the phone's own list shows only that. */
export type RowStyle =
  | { kind: "coin"; mint: string; symbol: string; name?: string; marketCap?: string; valueLabel?: string; detail?: string; progressPct?: number; graduated?: boolean; change?: string; up?: boolean; logo?: string }
  | { kind: "coinHero"; mint: string; symbol: string; name?: string; marketCap?: string; address: string; image?: string; logo?: string }
  /** The coin being created, as it stands so far. `image` is a file in the images folder. */
  | { kind: "coinPreview"; name: string; symbol: string; detail?: string; image?: string }
  | { kind: "progress"; label: string; pct: number }
  | { kind: "stat"; label: string; value: string }
  | { kind: "button"; tone: "buy" | "sell" | "primary" | "plain"; glyph?: string }
  | { kind: "nav"; label?: string; value?: string; glyph?: string; badge?: string; tone?: "danger" }
  | { kind: "wallet"; sol: string; usd?: string }
  | { kind: "qr"; modules: string[] }
  /** The Wallet tab: its total, action buttons and token list. */
  | { kind: "balance"; value: string; address: string; change?: string; detail?: string; up: boolean }
  | { kind: "action"; glyph: string; cols: number; span: number }
  | { kind: "section" }
  | { kind: "asset"; mint: string; name: string; symbol: string; detail?: string; value?: string; change?: string; up?: boolean; logo?: string; verified: boolean }
  /** The Swap tab. `span` is out of 12 across the screen; `cols` is how many share a line. */
  | { kind: "swapAmount"; part: string; label: string; value: string; usd?: string; cols: number; span: number }
  | { kind: "tokenPill"; part: string; mint: string; symbol: string; logo?: string; verified: boolean; cols: number; span: number }
  | { kind: "swapBalance"; part: string; value: string; cols?: number; span?: number }
  | { kind: "chip"; part: string; cols: number; span: number }
  | { kind: "flip" }
  | { kind: "warn" };

export interface Row {
  text: string;
  icon: number;
  enabled: boolean;
  action?: Action;
  style?: RowStyle;
}

export interface Screen {
  /** GET path that re-renders this screen; "" for screens that must not be
   * re-fetched (confirm and result screens). */
  path: string;
  header: string;
  rows: Row[];
  selected: number;
  /** Auto-refresh interval while visible; 0 = never. */
  refreshMs: number;
  /** One of the bottom tabs, which Left and Right move between. */
  tab?: boolean;
}

export type Nav = "push" | "replace" | "back" | "home" | "close" | "none";

export interface UiResponse {
  nav: Nav;
  screen?: Screen;
  toast?: { text: string; level: "info" | "success" | "error" };
}

/** Whatever answers the phone. Returns null for unknown routes. */
export interface UiHandler {
  handle(method: string, url: URL, body: Record<string, unknown>): Promise<UiResponse | null>;
}

const DRY_RUN_URI = "https://example.invalid/pumpv-dry-run.json";
const MAYHEM_WARNING = "MAYHEM coin: RUGR won't buy it";
const LAUNCH_RESERVE_LAMPORTS = new BN(30_000_000); // 0.03 SOL for rent + fees
const SWAP_RESERVE_LAMPORTS = new BN(10_000_000); // 0.01 SOL for fees and new token accounts
const SWAP_MAX_EXTRA_LAMPORTS = new BN(20_000_000); // what a swap may cost beyond its amount
const HIGH_PRICE_IMPACT_PCT = 5;
const SWAP_QUOTE_FRESH_MS = 8_000;
const MAX_WALLET_ROWS = 30;

export const NAV: RowStyle = { kind: "nav" };
export const WARN: RowStyle = { kind: "warn" };
const BUY: RowStyle = { kind: "button", tone: "buy" };
export const SELL: RowStyle = { kind: "button", tone: "sell" };
export const PRIMARY: RowStyle = { kind: "button", tone: "primary" };
export const PLAIN: RowStyle = { kind: "button", tone: "plain" };

export function row(text: string, icon: number, action?: Action, style?: RowStyle): Row {
  return { text: phoneText(text, 34), icon, enabled: Boolean(action), action, style };
}

export function info(text: string, icon: number = Icon.None, style?: RowStyle): Row {
  return { text: phoneText(text, 34), icon, enabled: false, style };
}

export function stat(label: string, value: string, icon: number = Icon.None): Row {
  return info(`${label} ${value}`, icon, { kind: "stat", label: phoneText(label, 24), value: phoneText(value, 28) });
}

export function screen(path: string, header: string, rows: Row[], opts: { selected?: number; refreshMs?: number; tab?: boolean } = {}): Screen {
  const firstEnabled = rows.findIndex((r) => r.enabled);
  return {
    path,
    header: phoneText(header, 24),
    rows,
    selected: opts.selected ?? Math.max(0, firstEnabled),
    refreshMs: opts.refreshMs ?? 0,
    ...(opts.tab ? { tab: true } : {}),
  };
}

export const open = (path: string): Action => ({ kind: "open", path });
export const post = (path: string, body?: Record<string, unknown>): Action => ({ kind: "post", path, body });
const postQuietly = (path: string, body?: Record<string, unknown>): Action => ({ kind: "post", path, body, quiet: true });
export const toast = (text: string, level: "info" | "success" | "error" = "info"): UiResponse => ({
  nav: "none",
  toast: { text: phoneText(text, 120), level },
});

/** "1.5" as a whole number of the smallest unit, with no rounding through floats. */
export function toRawAmount(text: unknown, decimals: number): BN {
  const s = String(text ?? "").trim().replace(",", ".");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new UserError("Enter an amount like 0.1");
  const [whole, fraction = ""] = s.split(".");
  const digits = fraction.padEnd(decimals, "0").slice(0, decimals);
  return new BN(whole || "0").mul(new BN(10).pow(new BN(decimals))).add(new BN(digits || "0"));
}

/** The other way round, keeping at most `places` decimals and trimming trailing zeros. */
export function fromRawAmount(raw: BN, decimals: number, places = decimals): string {
  const text = raw.toString().padStart(decimals + 1, "0");
  const whole = text.slice(0, text.length - decimals);
  const fraction = text.slice(text.length - decimals, text.length - decimals + places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

const count = (n: number, thing: string) => `${fmtCompact(n)} ${thing}${n === 1 ? "" : "s"}`;

export function parseSolInput(v: unknown): number {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(",", ".") : "";
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new UserError("Enter an amount like 0.1");
  const n = Number(s);
  if (!(n > 0)) throw new UserError("Amount must be more than 0.");
  return n;
}

interface LaunchDraft {
  name: string;
  symbol: string;
  description: string;
  image: string | null;
  buyIndex: number;
}

type Pending =
  | { kind: "buy"; quote: BuyQuote; symbol: string }
  | { kind: "sell"; quote: SellQuote; symbol: string }
  | { kind: "launch"; draft: LaunchDraft; initialBuyLamports: BN; expectedTokens: BN }
  | { kind: "swap"; from: SwapToken; to: SwapToken; amount: BN; minOut: BN };

interface SwapToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Absent for SOL, which has no token account. */
  program?: PublicKey;
  logo?: string;
  verified: boolean;
  usdPrice?: number;
}

interface WalletAsset {
  name: string;
  symbol: string;
  mint: string;
  amount: string;
  usd?: number;
  change?: number;
  logo?: string;
  verified: boolean;
  action: Action;
}

export interface AppDeps {
  config: Config;
  connection: Connection;
  wallet: Keypair;
  engine: PumpEngine;
  /** RUGR's server: Trending and New, and launches. */
  api: RugrApi;
  meta: MetaResolver;
  price: SolPrice;
  history: History;
  watchlist: Watchlist;
  imagesDir: string;
  /** Overridable for tests. */
  send?: (connection: Connection, built: BuiltTx) => Promise<string>;
  upload?: (input: MetadataInput) => Promise<string>;
  jupiter?: Jupiter;
  tokens?: TokenDirectory;
  paste?: () => Promise<string>;
  log?: (msg: string) => void;
}

interface Outcome {
  simulated: boolean;
  signature?: string;
  units?: number;
}

export class PhoneApp implements UiHandler {
  private quotes: QuoteStore<Pending>;
  private draft: LaunchDraft = PhoneApp.emptyDraft();
  private queue: Promise<unknown> = Promise.resolve();
  private swapForm = { from: SOL_MINT, to: USDC_MINT, amount: "" };
  private lastSwapOrder: { key: string; at: number; order: SwapOrder } | null = null;

  constructor(private d: AppDeps) {
    this.quotes = new QuoteStore(d.config.quoteTtlSeconds * 1000);
  }

  private static emptyDraft(): LaunchDraft {
    return { name: "", symbol: "", description: "", image: null, buyIndex: 0 };
  }

  private get me(): PublicKey {
    return this.d.wallet.publicKey;
  }

  private get cfg(): Config {
    return this.d.config;
  }

  /** A value the way pump.fun shows it: in dollars, or SOL if the price is unknown. */
  private money(sol: number): string {
    const usd = this.d.price.peek();
    return usd === null ? `${fmtSol(sol)} SOL` : fmtUsd(sol * usd);
  }

  /** "0.1 SOL ($9.58)", or just "0.1 SOL" if the price is unknown. */
  private solAndUsd(sol: number): string {
    const usd = this.d.price.peek();
    return `${fmtSol(sol)} SOL${usd === null ? "" : ` (${fmtUsd(sol * usd)})`}`;
  }

  private coinRow(text: string, c: { mint: string; symbol: string; name?: string; marketCap?: string; valueLabel?: string; detail?: string; progressPct?: number; graduated?: boolean; change?: string; up?: boolean; logo?: string }): Row {
    const name = phoneText(c.name ?? "", 28) || undefined;
    return row(text, Icon.Bawsaq, open(`/ui/token?mint=${c.mint}`), { kind: "coin", ...c, name });
  }

  /** Returns null for unknown routes. */
  async handle(method: string, url: URL, body: Record<string, unknown>): Promise<UiResponse | null> {
    try {
      return await this.route(method, url.pathname, url.searchParams, body);
    } catch (e) {
      if (e instanceof UserError) return toast(e.message, "error");
      this.d.log?.(`error on ${method} ${url.pathname}: ${(e as Error).stack ?? String(e)}`);
      return toast(`Error: ${(e as Error).message}`, "error");
    }
  }

  private async route(method: string, path: string, q: URLSearchParams, b: Record<string, unknown>): Promise<UiResponse | null> {
    const push = (s: Screen): UiResponse => ({ nav: "push", screen: s });
    if (method === "GET") {
      switch (path) {
        case "/ui/home": return push(await this.home());
        case "/ui/wallet": return push(await this.walletScreen());
        case "/ui/list": return push(await this.listScreen(q.get("kind") ?? ""));
        case "/ui/watchlist": return push(await this.watchlistScreen());
        case "/ui/history": return push(this.historyScreen());
        case "/ui/token": return push(await this.tokenScreen(this.mintParam(q.get("mint"))));
        case "/ui/launch": return push(this.launchScreen());
        case "/ui/swap": {
          // Coming from a token elsewhere in the app fills that token in.
          const mint = q.get("mint");
          if (mint) await this.prefillSwap(mint, q.get("side") === "from" ? "from" : "to");
          return push(await this.swapScreen());
        }
        case "/ui/swap/pick": return push(await this.swapPickScreen(q.get("side") === "from" ? "from" : "to"));
      }
      return null;
    }
    if (method !== "POST") return null;
    switch (path) {
      case "/ui/search": return push(await this.tokenScreen(this.mintParam(b.mint, "That's not a valid token address.")));
      case "/ui/swap/set": return this.setSwapToken(b, b.mint);
      case "/ui/swap/paste": {
        const text = this.d.paste ? await this.d.paste() : "";
        return this.setSwapToken(b, text, "Copy a token address first, then press Paste.");
      }
      case "/ui/swap/amount": return this.setSwapAmount(b);
      case "/ui/swap/flip": {
        const f = this.swapForm;
        [f.from, f.to] = [f.to, f.from];
        f.amount = "";
        return { nav: "replace", screen: await this.swapScreen() };
      }
      case "/ui/swap/review": return this.reviewSwap();
      case "/ui/watch": return this.watch(b);
      case "/ui/show-address": return toast(this.mintParam(b.mint).toBase58());
      case "/ui/quote/buy": return this.quoteBuy(b);
      case "/ui/quote/sell": return this.quoteSell(b);
      case "/ui/execute": return this.execute(b);
      case "/ui/launch/set": return this.launchSet(b);
      case "/ui/launch/latest-image": return this.launchLatestImage();
      case "/ui/launch/next-buy": {
        this.draft.buyIndex = (this.draft.buyIndex + 1) % this.cfg.launchBuyPresetsSol.length;
        return { nav: "replace", screen: this.launchScreen() };
      }
      case "/ui/launch/reset": {
        this.draft = PhoneApp.emptyDraft();
        return { nav: "replace", screen: this.launchScreen(), toast: { text: "Cleared", level: "info" } };
      }
      case "/ui/launch/review": return this.launchReview();
    }
    return null;
  }

  private mintParam(v: unknown, message = "Missing or invalid token address."): PublicKey {
    const pk = typeof v === "string" ? parsePublicKey(v) : null;
    if (!pk) throw new UserError(message);
    return pk;
  }

  // ---- browsing ----------------------------------------------------------

  async home(): Promise<Screen> {
    const [lamports, usd] = await Promise.all([this.d.engine.solBalance(this.me).catch(() => null), this.d.price.get()]);
    const sol = lamports ? lamportsToSol(lamports) : null;
    const rows = [
      row(`Wallet ${sol !== null ? fmtSol(sol) + " SOL" : "(RPC offline)"}`, Icon.Profile, { kind: "tab", path: "/ui/wallet" }, {
        kind: "wallet",
        sol: sol !== null ? `${fmtSol(sol)} SOL` : "RPC offline",
        usd: sol !== null && usd !== null ? fmtUsd(sol * usd) : undefined,
      }),
      row("Trending", Icon.Bawsaq, open("/ui/list?kind=trending"), { kind: "nav", glyph: "bars" }),
      row("New Coins", Icon.Broadcast, open("/ui/list?kind=new"), { kind: "nav", glyph: "spark" }),
      row("Watchlist", Icon.AddTag, open("/ui/watchlist"), { kind: "nav", glyph: "star" }),
      row("Search", Icon.EyeFind, {
        kind: "input",
        title: "Token address (mint)",
        maxLength: 44,
        path: "/ui/search",
        field: "mint",
      }, { kind: "nav", glyph: "search" }),
      row("Create Coin", Icon.Party, open("/ui/launch"), { kind: "button", tone: "primary", glyph: "plus" }),
    ];
    if (this.cfg.dryRun) rows.push(info("PRACTICE: nothing is sent", Icon.Lock, WARN));
    return screen("/ui/home", "RUGR", rows, { refreshMs: 30_000, tab: true });
  }

  async listScreen(kind: string): Promise<Screen> {
    if (kind !== "trending" && kind !== "new") throw new UserError("Unknown list.");
    const title = kind === "trending" ? "Trending" : "New Coins";
    const path = `/ui/list?kind=${kind}`;
    void this.d.price.get().catch(() => undefined); // for the next refresh; lists don't wait for it
    // Only coins launched through RUGR. Any other token is a search away, and trades the same.
    const coins = await this.d.api.coins(kind);
    const search = row("Search any token", Icon.EyeFind, { kind: "input", title: "Token address (mint)", maxLength: 44, path: "/ui/search", field: "mint" }, NAV);
    if (coins === null) {
      return screen(path, title, [
        info("Can't reach RUGR right now"),
        info("Check your connection, then retry"),
        row("Retry", Icon.History, { kind: "refresh" }, PLAIN),
        search,
      ], { refreshMs: 10_000 });
    }
    if (coins.length === 0) {
      return screen(path, title, [
        info("No coins launched on RUGR yet"),
        info("Take a photo and launch the first"),
        row("Create Coin", Icon.Party, open("/ui/launch"), { kind: "button", tone: "primary", glyph: "plus" }),
        search,
      ], { refreshMs: 20_000 });
    }
    const rows = coins.map((c) => {
      this.d.meta.remember(c.mint, { name: c.name, symbol: c.symbol });
      const sym = ticker(c.symbol, c.mint);
      const mc = c.marketCapUsd !== undefined ? fmtUsd(c.marketCapUsd) : c.marketCapSol !== undefined ? this.money(c.marketCapSol) : undefined;
      const age = kind === "new" ? fmtAge(Date.now() - c.createdMs) : "";
      const volume = c.volumeUsd ? `Vol ${fmtUsd(c.volumeUsd)}` : "";
      const people = c.traders ? count(c.traders, "trader") : c.holders ? count(c.holders, "holder") : "";
      return this.coinRow([sym, mc, age, people].filter(Boolean).join(" "), {
        mint: c.mint,
        symbol: sym,
        name: c.name,
        marketCap: mc,
        detail: [age, volume, people].filter(Boolean).join(" · ") || undefined,
        progressPct: c.graduated ? undefined : c.progressPct,
        graduated: c.graduated,
        change: c.changePct === undefined ? undefined : fmtPercentChange(c.changePct),
        up: (c.changePct ?? 0) >= 0,
        logo: c.image,
      });
    });
    rows.push(search);
    return screen(path, title, rows, { refreshMs: kind === "new" ? 10_000 : 20_000 });
  }

  async tokenScreen(mint: PublicKey): Promise<Screen> {
    const m = mint.toBase58();
    const known = (await this.tokens.lookup([m])).get(m);
    let state: TokenState;
    try {
      state = await this.d.engine.getState(mint, this.me);
    } catch (e) {
      if (e instanceof NotOnPumpError) return this.swapOnlyScreen(mint, known);
      throw e;
    }
    const [meta] = await Promise.all([
      this.d.meta.resolve(mint).catch(() => ({ name: undefined, symbol: undefined })),
      this.d.price.get(),
    ]);
    const balance = await this.d.engine.tokenBalance(mint, state.tokenProgram, this.me);
    const value = balance.isZero()
      ? null
      : await this.d.engine.holdingValue(state, this.me, balance).catch(() => null);
    const sym = ticker(meta.symbol, m);
    const venue = state.progressPct === null ? "PumpSwap" : `curve ${fmtPercent(state.progressPct)}`;
    const marketCap = this.money(state.marketCapSol);
    const holding = `${fmtCompact(rawToUi(balance, state.decimals))}` + (value ? ` = ${this.money(lamportsToSol(value))}` : "");
    const rows: Row[] = [
      info(meta.name ? meta.name : shortAddr(m), Icon.None, {
        kind: "coinHero",
        mint: m,
        symbol: sym,
        name: phoneText(meta.name ?? "", 28) || undefined,
        marketCap,
        address: shortAddr(m),
      }),
      info(
        `MC ${marketCap} ${venue}`,
        Icon.None,
        state.progressPct === null ? { kind: "stat", label: "Trading on", value: "PumpSwap" } : { kind: "progress", label: "Bonding curve", pct: state.progressPct },
      ),
      info(`Price ${this.money(state.priceSol)}`, Icon.None, { kind: "stat", label: "Price", value: this.money(state.priceSol) }),
      ...this.marketRows(known),
      info(balance.isZero() ? "You hold 0" : `You hold ${holding}`, Icon.None, { kind: "stat", label: "Position", value: balance.isZero() ? "0" : holding }),
      ...(state.mayhem ? [info(MAYHEM_WARNING, Icon.Lock, WARN)] : []),
    ];
    const firstAction = rows.length;
    if (!state.mayhem) {
      for (const sol of this.cfg.buyPresetsSol) {
        rows.push(row(`Buy ${fmtSol(sol)} SOL`, Icon.Bawsaq, post("/ui/quote/buy", { mint: m, sol }), BUY));
      }
      rows.push(row("Buy other amount", Icon.Bawsaq, {
        kind: "input",
        title: `SOL to spend (max ${this.cfg.maxSolPerTrade})`,
        maxLength: 10,
        path: "/ui/quote/buy",
        field: "sol",
        body: { mint: m },
      }, BUY));
    }
    if (!balance.isZero()) {
      for (const pct of this.cfg.sellPresetsPercent) {
        rows.push(row(`Sell ${pct}%`, Icon.Attachment, post("/ui/quote/sell", { mint: m, percent: pct }), SELL));
      }
    }
    const watched = this.d.watchlist.has(m);
    rows.push(row(watched ? "Remove from watchlist" : "Add to watchlist", watched ? Icon.RemoveTag : Icon.AddTag, post("/ui/watch", { mint: m, on: !watched }), NAV));
    rows.push(row("Show address", Icon.EyeFind, post("/ui/show-address", { mint: m }), NAV));
    return screen(`/ui/token?mint=${m}`, sym, rows, { selected: firstAction, refreshMs: 10_000 });
  }

  private marketRows(k?: TokenInfo): Row[] {
    if (!k) return [];
    const rows: Row[] = [];
    if (k.change24hPct !== undefined) rows.push(stat("24h change", fmtPercentChange(k.change24hPct)));
    if (k.volume24hUsd !== undefined) rows.push(stat("24h volume", fmtUsd(k.volume24hUsd)));
    if (k.liquidityUsd) rows.push(stat("Liquidity", fmtUsd(k.liquidityUsd)));
    if (k.holders) rows.push(stat("Holders", fmtCompact(k.holders)));
    return rows;
  }

  /** A real token that isn't on pump.fun's curve or pool: Jupiter can still route it. */
  private async swapOnlyScreen(mint: PublicKey, known?: TokenInfo): Promise<Screen> {
    const m = mint.toBase58();
    const { name, symbol } = await this.tokenName(mint, known);
    const watched = this.d.watchlist.has(m);
    const rows: Row[] = [
      info(name, Icon.None, { kind: "coinHero", mint: m, symbol, name, marketCap: known?.marketCapUsd ? fmtUsd(known.marketCapUsd) : undefined, address: shortAddr(m), logo: known?.logo }),
      ...(known?.usdPrice !== undefined ? [stat("Price", fmtUsd(known.usdPrice))] : []),
      ...this.marketRows(known),
      row(`Swap ${symbol}`, Icon.History, { kind: "tab", path: `/ui/swap?mint=${m}` }, { kind: "button", tone: "primary", glyph: "swap" }),
      row(watched ? "Remove from watchlist" : "Add to watchlist", watched ? Icon.RemoveTag : Icon.AddTag, post("/ui/watch", { mint: m, on: !watched }), NAV),
      row("Show address", Icon.EyeFind, post("/ui/show-address", { mint: m }), NAV),
    ];
    return screen(`/ui/token?mint=${m}`, symbol, rows, { refreshMs: 20_000 });
  }

  async watchlistScreen(): Promise<Screen> {
    const mints = this.d.watchlist.list().slice(0, 20);
    const results = await Promise.allSettled(
      mints.map(async (m) => {
        const pk = new PublicKey(m);
        const [meta, state] = await Promise.all([
          this.d.meta.resolve(pk).catch(() => ({ name: undefined, symbol: undefined })),
          this.d.engine.getState(pk, this.me).catch(() => null),
        ]);
        return { m, meta, state };
      }),
    );
    const rows: Row[] = [];
    results.forEach((r, i) => {
      const m = mints[i];
      if (r.status !== "fulfilled") {
        rows.push(this.coinRow(shortAddr(m), { mint: m, symbol: shortAddr(m) }));
        return;
      }
      const sym = ticker(r.value.meta.symbol, m);
      const mc = r.value.state ? this.money(r.value.state.marketCapSol) : undefined;
      rows.push(this.coinRow(`${sym}${mc ? ` ${mc}` : ""}`, {
        mint: m,
        symbol: sym,
        name: r.value.meta.name,
        marketCap: mc,
        progressPct: r.value.state?.progressPct ?? undefined,
      }));
    });
    if (rows.length === 0) rows.push(info("Empty. Add tokens from their page."));
    return screen("/ui/watchlist", "Watchlist", rows, { refreshMs: 20_000 });
  }

  historyScreen(): Screen {
    const rows = this.d.history.recent(20).map((e) => {
      const sim = e.simulated ? " (sim)" : "";
      if (e.kind === "send") return info(`SEND ${fmtCompact(e.tokens)} ${e.symbol ?? ""}${sim}`, Icon.Attachment);
      if (e.kind === "swap") return row(`SWAP ${e.symbol ?? shortAddr(e.mint)}${sim}`, Icon.History, { kind: "tab", path: `/ui/swap?mint=${e.mint}` }, NAV);
      return row(
        `${e.kind === "launch" ? "CREATE" : e.kind.toUpperCase()} ${e.symbol ?? shortAddr(e.mint)} ${fmtSol(e.sol)}${sim}`,
        e.kind === "launch" ? Icon.Party : Icon.Bawsaq,
        open(`/ui/token?mint=${e.mint}`),
        NAV,
      );
    });
    if (rows.length === 0) rows.push(info("No activity yet"));
    return screen("/ui/history", "Activity", rows, { tab: true });
  }

  /** Fills a token into the swap form. A bad token stops here, before the form changes. */
  private async prefillSwap(mint: string, side: "from" | "to"): Promise<void> {
    await this.swapToken(mint);
    const f = this.swapForm;
    if (side === "from") {
      f.from = mint;
      f.to = mint === SOL_MINT ? USDC_MINT : SOL_MINT;
    } else {
      f.to = mint;
      f.from = mint === SOL_MINT ? USDC_MINT : SOL_MINT;
    }
    f.amount = "";
  }

  private async watch(b: Record<string, unknown>): Promise<UiResponse> {
    const mint = this.mintParam(b.mint);
    const on = b.on === true;
    this.d.watchlist.set(mint.toBase58(), on);
    return {
      nav: "replace",
      screen: await this.tokenScreen(mint),
      toast: { text: on ? "Added to watchlist" : "Removed from watchlist", level: "info" },
    };
  }

  // ---- swaps: any token for any other, by address -------------------------

  private get jupiter(): Jupiter {
    if (!this.d.jupiter) this.d.jupiter = new Jupiter();
    return this.d.jupiter;
  }

  private get tokens(): TokenDirectory {
    if (!this.d.tokens) this.d.tokens = new TokenDirectory();
    return this.d.tokens;
  }

  private async swapToken(mint: string): Promise<SwapToken> {
    const known = (await this.tokens.lookup([mint])).get(mint);
    const popular = POPULAR_TOKENS[mint];
    const common = { mint, logo: known?.logo, verified: known?.verified ?? false, usdPrice: known?.usdPrice };
    if (mint === SOL_MINT) return { ...common, symbol: "SOL", name: "Solana", decimals: 9, verified: true, usdPrice: known?.usdPrice ?? this.d.price.peek() ?? undefined };
    if (popular) return { ...common, ...popular, program: TOKEN_PROGRAM_ID };

    const pk = this.mintParam(mint);
    const account = await this.d.connection.getAccountInfo(pk, "confirmed");
    if (!account || !(account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID))) {
      throw new UserError("That isn't a token address.");
    }
    const meta = known?.symbol ? known : await this.d.meta.resolve(pk).catch(() => ({ name: undefined, symbol: undefined }));
    return {
      ...common,
      symbol: phoneText(meta.symbol ?? "", 10) || shortAddr(mint),
      name: phoneText(meta.name ?? "", 28) || shortAddr(mint),
      decimals: unpackMint(pk, account, account.owner).decimals,
      program: account.owner,
    };
  }

  private swapBalance(t: SwapToken): Promise<BN> {
    return t.program
      ? this.d.engine.tokenBalance(new PublicKey(t.mint), t.program, this.me)
      : this.d.engine.solBalance(this.me);
  }

  /** The most of this token a swap can use: for SOL, what's left after fees. */
  private swappable(t: SwapToken, balance: BN): BN {
    return t.program ? balance : BN.max(new BN(0), balance.sub(SWAP_RESERVE_LAMPORTS));
  }

  private async swapOrder(from: SwapToken, to: SwapToken, raw: BN): Promise<SwapOrder> {
    const key = `${from.mint}|${to.mint}|${raw.toString()}`;
    if (this.lastSwapOrder?.key === key && Date.now() - this.lastSwapOrder.at < SWAP_QUOTE_FRESH_MS) return this.lastSwapOrder.order;
    const order = await this.jupiter.order({
      inputMint: from.mint,
      outputMint: to.mint,
      amount: raw,
      taker: this.me,
      slippageBps: Math.round(this.d.engine.slippagePercent * 100),
    });
    this.lastSwapOrder = { key, at: Date.now(), order };
    return order;
  }

  /** Why this swap can't go ahead, or null if it can. */
  private async swapBlocker(from: SwapToken, to: SwapToken, raw: BN, balance: BN): Promise<string | null> {
    if (!from.program && lamportsToSol(raw) > this.cfg.maxSolPerTrade) return `Max per trade is ${this.cfg.maxSolPerTrade} SOL.`;
    if (raw.gt(this.swappable(from, balance))) {
      return from.program ? `Not enough ${from.symbol}.` : "Not enough SOL. Keep about 0.01 for fees.";
    }
    if (to.program) {
      const pump = await this.d.engine.getState(new PublicKey(to.mint), this.me).catch(() => null);
      if (pump?.mayhem) return "RUGR only buys regular coins, not Mayhem coins.";
    }
    return null;
  }

  async swapScreen(): Promise<Screen> {
    const f = this.swapForm;
    const [from, to] = await Promise.all([this.swapToken(f.from), this.swapToken(f.to)]);
    const [fromBalance, toBalance] = await Promise.all([
      this.swapBalance(from).catch(() => new BN(0)),
      this.swapBalance(to).catch(() => new BN(0)),
    ]);
    const raw = f.amount ? toRawAmount(f.amount, from.decimals) : new BN(0);
    const dollars = (t: SwapToken, amount: BN) => (t.usdPrice === undefined || amount.isZero() ? undefined : fmtUsd(rawToUi(amount, t.decimals) * t.usdPrice));

    let order: SwapOrder | null = null;
    let problem: string | null = null;
    if (!raw.isZero()) {
      problem = await this.swapBlocker(from, to, raw, fromBalance);
      try {
        order = await this.swapOrder(from, to, raw);
        if (!problem && !order.transaction) problem = order.problem ?? "No way to swap this right now.";
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        problem ??= e.message;
      }
    }

    const pill = (side: "from" | "to", t: SwapToken, part: string): Row =>
      row(`${side === "from" ? "From" : "To"} ${t.symbol}`, Icon.Bawsaq, open(`/ui/swap/pick?side=${side}`), {
        kind: "tokenPill",
        part,
        mint: t.mint,
        symbol: t.symbol,
        logo: t.logo,
        verified: t.verified,
        cols: 2,
        span: 6,
      });
    const out = order ? fromRawAmount(order.outAmount, to.decimals, 6) : "0";
    const rows: Row[] = [
      row(`You pay ${f.amount || "0"} ${from.symbol}`, Icon.Email, {
        kind: "input",
        title: `Amount of ${phoneText(from.symbol, 12)} to pay`,
        maxLength: 24,
        initial: f.amount,
        path: "/ui/swap/amount",
        field: "amount",
      }, { kind: "swapAmount", part: "pay", label: "You pay", value: phoneText(f.amount || "0", 16), usd: dollars(from, raw), cols: 2, span: 6 }),
      pill("from", from, "pay"),
      info(`Balance ${fromRawAmount(fromBalance, from.decimals, 4)}`, Icon.None, { kind: "swapBalance", part: "pay", value: fromRawAmount(fromBalance, from.decimals, 4), cols: 3, span: 8 }),
      row("50%", Icon.Bawsaq, postQuietly("/ui/swap/amount", { percent: 50 }), { kind: "chip", part: "pay", cols: 3, span: 2 }),
      row("100%", Icon.Bawsaq, postQuietly("/ui/swap/amount", { percent: 100 }), { kind: "chip", part: "pay", cols: 3, span: 2 }),
      row("Flip", Icon.History, postQuietly("/ui/swap/flip"), { kind: "flip" }),
      info(`You receive ${out} ${to.symbol}`, Icon.None, { kind: "swapAmount", part: "get", label: "You receive", value: phoneText(out, 16), usd: order ? dollars(to, order.outAmount) : undefined, cols: 2, span: 6 }),
      pill("to", to, "get"),
      info(`Balance ${fromRawAmount(toBalance, to.decimals, 4)}`, Icon.None, { kind: "swapBalance", part: "get", value: fromRawAmount(toBalance, to.decimals, 4) }),
    ];
    if (order) {
      rows.push(stat("At least", `${fromRawAmount(order.minOut, to.decimals, 6)} ${to.symbol}`));
      rows.push(stat("Price impact", fmtPercent(order.priceImpactPct)));
      if (order.priceImpactPct >= HIGH_PRICE_IMPACT_PCT) rows.push(info("High price impact: you'd lose value", Icon.Lock, WARN));
    }
    if (problem) rows.push(info(problem, Icon.Lock, WARN));
    if (order && !problem) rows.push(row("Review swap", Icon.Ticked, post("/ui/swap/review"), PRIMARY));
    if (this.cfg.dryRun) rows.push(info("PRACTICE: nothing is sent", Icon.Lock, WARN));
    rows.push(...(await this.swapTokenList(from.mint, to.mint)));
    const review = rows.findIndex((r) => r.text === "Review swap");
    // With no quote yet, usually from the service's rate limit, try again soon.
    const refreshMs = raw.isZero() ? 0 : order ? 15_000 : 3_000;
    return screen("/ui/swap", "Swap", rows, { selected: review >= 0 ? review : 0, refreshMs, tab: true });
  }

  /** Under the form: paste any token's address, or tap a well-known one to swap into it. */
  private async swapTokenList(fromMint: string, toMint: string): Promise<Row[]> {
    const mints = [SOL_MINT, ...Object.keys(POPULAR_TOKENS)].filter((m) => m !== fromMint && m !== toMint);
    const known = await this.tokens.lookup(mints);
    return [
      info("Tokens", Icon.None, { kind: "section" }),
      row("Paste token address", Icon.Attachment, postQuietly("/ui/swap/paste", { side: "to", stay: true }), { kind: "nav", glyph: "paste" }),
      ...mints.map((m) => {
        const k = known.get(m);
        const name = m === SOL_MINT ? "Solana" : POPULAR_TOKENS[m].name;
        const symbol = m === SOL_MINT ? "SOL" : POPULAR_TOKENS[m].symbol;
        return row(`${symbol} ${name}`, Icon.Bawsaq, postQuietly("/ui/swap/set", { side: "to", mint: m, stay: true }), {
          kind: "asset",
          mint: m,
          name,
          symbol,
          detail: symbol,
          value: k?.usdPrice === undefined ? undefined : fmtUsd(k.usdPrice),
          change: k?.change24hPct === undefined ? undefined : fmtPercentChange(k.change24hPct),
          up: (k?.change24hPct ?? 0) >= 0,
          logo: k?.logo,
          verified: k?.verified ?? false,
        });
      }),
    ];
  }

  private async setSwapAmount(b: Record<string, unknown>): Promise<UiResponse> {
    const from = await this.swapToken(this.swapForm.from);
    if (b.percent !== undefined) {
      const available = this.swappable(from, await this.swapBalance(from));
      const raw = Number(b.percent) >= 100 ? available : available.muln(Number(b.percent)).divn(100);
      if (raw.isZero()) throw new UserError(`You have no ${from.symbol} to swap.`);
      this.swapForm.amount = fromRawAmount(raw, from.decimals);
    } else {
      const raw = toRawAmount(b.amount, from.decimals);
      this.swapForm.amount = raw.isZero() ? "" : fromRawAmount(raw, from.decimals);
    }
    return { nav: "replace", screen: await this.swapScreen() };
  }

  private async tokenName(mint: PublicKey, known?: TokenInfo): Promise<{ name: string; symbol: string }> {
    const meta = known?.symbol ? known : await this.d.meta.resolve(mint).catch(() => ({ name: undefined, symbol: undefined }));
    const short = shortAddr(mint.toBase58());
    return { name: phoneText(meta.name ?? "", 28) || short, symbol: phoneText(meta.symbol ?? "", 10) || short };
  }

  private async swapPickScreen(side: "from" | "to"): Promise<Screen> {
    const holdings = await this.d.engine.holdings(this.me).catch(() => []);
    const mints = [SOL_MINT, ...holdings.map((h) => h.mint.toBase58())];
    const popular = Object.keys(POPULAR_TOKENS).filter((m) => !mints.includes(m));
    const known = await this.tokens.lookup([...mints, ...popular]);
    const lamports = await this.d.engine.solBalance(this.me).catch(() => new BN(0));

    const pick = (mint: string, name: string, symbol: string, detail: string | undefined): Row =>
      row(`${symbol} ${detail ?? ""}`.trim(), Icon.Bawsaq, post("/ui/swap/set", { side, mint }), {
        kind: "asset",
        mint,
        name: phoneText(name, 28),
        symbol: phoneText(symbol, 10),
        detail: detail && phoneText(detail, 24),
        logo: known.get(mint)?.logo,
        verified: known.get(mint)?.verified ?? false,
      });

    const yours: Row[] = [pick(SOL_MINT, "Solana", "SOL", `${fmtSol(lamportsToSol(lamports))} SOL`)];
    for (const h of holdings.slice(0, 20)) {
      const m = h.mint.toBase58();
      const { name, symbol } = await this.tokenName(h.mint, known.get(m));
      yours.push(pick(m, name, symbol, `${fmtCompact(rawToUi(h.amountRaw, h.decimals))} ${symbol}`));
    }
    return screen("", "Select a token", [
      row("Paste token address", Icon.Attachment, post("/ui/swap/paste", { side }), { kind: "button", tone: "primary", glyph: "paste" }),
      row("Type token address", Icon.EyeFind, { kind: "input", title: "Token address (CA)", maxLength: 44, path: "/ui/swap/set", field: "mint", body: { side } }, { kind: "nav", glyph: "search" }),
      info("Your tokens", Icon.None, { kind: "section" }),
      ...yours,
      ...(popular.length ? [info("Popular", Icon.None, { kind: "section" })] : []),
      ...popular.map((m) => pick(m, POPULAR_TOKENS[m].name, POPULAR_TOKENS[m].symbol, undefined)),
    ]);
  }

  private async setSwapToken(b: Record<string, unknown>, text: unknown, message = "That's not a valid token address."): Promise<UiResponse> {
    const side = b.side === "from" ? "from" : "to";
    const mint = this.mintParam(text, message).toBase58();
    await this.swapToken(mint); // refuses anything that isn't a token
    const f = this.swapForm;
    const other = side === "from" ? f.to : f.from;
    if (mint === other) {
      [f.from, f.to] = [f.to, f.from]; // picking the other side's token swaps them round
      f.amount = "";
    } else {
      if (side === "from") {
        f.from = mint;
        f.amount = "";
      } else {
        f.to = mint;
      }
    }
    return { nav: b.stay ? "replace" : "back", screen: await this.swapScreen() };
  }

  private async reviewSwap(): Promise<UiResponse> {
    const f = this.swapForm;
    if (!f.amount) throw new UserError("Enter an amount first.");
    const [from, to] = await Promise.all([this.swapToken(f.from), this.swapToken(f.to)]);
    const raw = toRawAmount(f.amount, from.decimals);
    const problem = await this.swapBlocker(from, to, raw, await this.swapBalance(from));
    if (problem) throw new UserError(problem);
    const order = await this.swapOrder(from, to, raw);
    if (!order.transaction) throw new UserError(order.problem ?? "No way to swap this right now.");

    const id = this.quotes.put({ kind: "swap", from, to, amount: raw, minOut: order.minOut });
    const coin = to.program ? to : from;
    const rows: Row[] = [
      info(`Swap ${from.symbol} for ${to.symbol}`, Icon.Bawsaq, { kind: "coinHero", mint: coin.mint, symbol: `${from.symbol} to ${to.symbol}`, name: phoneText(coin.name, 28), address: shortAddr(coin.mint), logo: coin.logo }),
      stat("You pay", `${fromRawAmount(raw, from.decimals, 6)} ${from.symbol}`),
      stat("Get about", `${fromRawAmount(order.outAmount, to.decimals, 6)} ${to.symbol}`),
      stat("At least", `${fromRawAmount(order.minOut, to.decimals, 6)} ${to.symbol}`),
      stat("Price impact", fmtPercent(order.priceImpactPct)),
      ...(order.priceImpactPct >= HIGH_PRICE_IMPACT_PCT ? [info("High price impact: you'd lose value", Icon.Lock, WARN)] : []),
      stat("Via", "Jupiter"),
      ...this.dryRunRows(),
    ];
    return { nav: "push", screen: this.confirmScreen("Confirm swap", rows, "SWAP", id, PRIMARY) };
  }

  private async runSwap(p: Extract<Pending, { kind: "swap" }>): Promise<UiResponse> {
    // A confirm screen can sit for a while, so get a fresh transaction, held to the minimum the player saw.
    this.lastSwapOrder = null;
    const order = await this.swapOrder(p.from, p.to, p.amount);
    if (!order.transaction) throw new UserError(order.problem ?? "No way to swap this right now.");
    if (order.outAmount.lt(p.minOut)) throw new UserError("Price moved past your slippage. Try again.");
    let height = order.lastValidBlockHeight;
    if (height === undefined) height = (await this.d.connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
    const built = signSwap(order.transaction, height, this.d.wallet);

    const maxSpent = p.from.program ? SWAP_MAX_EXTRA_LAMPORTS : p.amount.add(SWAP_MAX_EXTRA_LAMPORTS);
    const check = await checkSwap(this.d.connection, built, this.me, maxSpent);
    if (!check.ok) throw new UserError(check.error ?? "Simulation failed.");

    const out: Outcome = this.cfg.dryRun
      ? { simulated: true, units: check.unitsConsumed }
      : { simulated: false, signature: await (this.d.send ?? sendAndConfirm)(this.d.connection, built) };
    const coin = p.to.program ? p.to : p.from;
    const coinRaw = p.to.program ? order.outAmount : p.amount;
    const solRaw = p.from.program ? (p.to.program ? new BN(0) : order.outAmount) : p.amount;
    this.d.history.append({
      ts: Date.now(),
      kind: "swap",
      mint: coin.mint,
      symbol: `${p.from.symbol} to ${p.to.symbol}`,
      sol: lamportsToSol(solRaw),
      tokens: rawToUi(coinRaw, coin.decimals),
      signature: out.signature,
      simulated: out.simulated,
    });
    this.swapForm.amount = "";
    return this.result(out, out.simulated ? "Simulated swap" : "Swapped", [
      `${fromRawAmount(p.amount, p.from.decimals, 6)} ${p.from.symbol}`,
      `for about ${fromRawAmount(order.outAmount, p.to.decimals, 6)} ${p.to.symbol}`,
    ]);
  }

  // ---- the wallet ---------------------------------------------------------

  async walletScreen(): Promise<Screen> {
    const [lamports, holdings] = await Promise.all([
      this.d.engine.solBalance(this.me).catch(() => null),
      this.d.engine.holdings(this.me).catch(() => []),
    ]);
    const [known, values, chainPrice] = await Promise.all([
      this.tokens.lookup([SOL_MINT, ...holdings.map((h) => h.mint.toBase58())]),
      this.d.engine.valueHoldings(this.me, holdings).catch(() => new Map<string, { lamports: BN | null; venue: unknown }>()),
      this.d.price.get().catch(() => null),
    ]);
    const solPrice = known.get(SOL_MINT)?.usdPrice ?? chainPrice ?? undefined;

    const assets: WalletAsset[] = [{
      name: "Solana",
      symbol: "SOL",
      mint: SOL_MINT,
      amount: `${fmtSol(lamportsToSol(lamports ?? new BN(0)))} SOL`,
      usd: solPrice === undefined || lamports === null ? undefined : lamportsToSol(lamports) * solPrice,
      change: known.get(SOL_MINT)?.change24hPct,
      logo: known.get(SOL_MINT)?.logo,
      verified: true,
      action: { kind: "tab", path: `/ui/swap?mint=${SOL_MINT}&side=from` },
    }];
    for (const h of holdings) {
      const m = h.mint.toBase58();
      const k = known.get(m);
      const held = rawToUi(h.amountRaw, h.decimals);
      const value = values.get(m);
      const onCurve = value?.lamports && solPrice !== undefined ? lamportsToSol(value.lamports) * solPrice : undefined;
      const { name, symbol } = await this.tokenName(h.mint, k);
      assets.push({
        name,
        symbol,
        mint: m,
        amount: `${fmtCompact(held)} ${symbol}`,
        usd: k?.usdPrice !== undefined ? held * k.usdPrice : onCurve,
        change: k?.change24hPct,
        logo: k?.logo,
        verified: k?.verified ?? false,
        // A pump.fun coin has its own page; anything else opens in Swap, ready to sell.
        action: value && value.venue !== null ? open(`/ui/token?mint=${m}`) : { kind: "tab", path: `/ui/swap?mint=${m}&side=from` },
      });
    }
    assets.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

    // What each token was worth a day ago, from its own 24-hour change.
    const dayChange = (a: WalletAsset) => (a.usd === undefined || a.change === undefined ? 0 : a.usd - a.usd / (1 + a.change / 100));
    const total = assets.reduce((sum, a) => sum + (a.usd ?? 0), 0);
    const change = assets.reduce((sum, a) => sum + dayChange(a), 0);
    const before = total - change;
    const hasChange = assets.some((a) => a.change !== undefined && (a.usd ?? 0) > 0);

    const action = (label: string, glyph: string, act: Action): Row => row(label, Icon.Bawsaq, act, { kind: "action", glyph, cols: 4, span: 3 });
    return screen("/ui/wallet", "Wallet", [
      row(`Copy address ${shortAddr(this.me.toBase58())}`, Icon.Attachment, postQuietly("/ui/wallet/copy-address"), {
        kind: "balance",
        value: lamports === null ? "Offline" : fmtMoney(total),
        address: shortAddr(this.me.toBase58()),
        change: hasChange ? fmtMoneyChange(change) : undefined,
        detail: hasChange && before > 0 ? fmtPercentChange((change / before) * 100) : undefined,
        up: change >= 0,
      }),
      action("Send", "send", open("/ui/send")),
      action("Swap", "swap", { kind: "tab", path: "/ui/swap" }),
      action("Receive", "qr", open("/ui/deposit")),
      action("Settings", "gear", open("/ui/settings")),
      info("Tokens", Icon.None, { kind: "section" }),
      ...assets.slice(0, MAX_WALLET_ROWS).map((a) =>
        row(`${a.symbol} ${a.amount}`, Icon.Bawsaq, a.action, {
          kind: "asset",
          mint: a.mint,
          name: a.name,
          symbol: a.symbol,
          detail: phoneText(a.amount, 24),
          value: a.usd === undefined ? undefined : fmtMoney(a.usd),
          change: a.usd === undefined || a.change === undefined ? undefined : fmtMoneyChange(dayChange(a)),
          up: dayChange(a) >= 0,
          logo: a.logo,
          verified: a.verified,
        }),
      ),
    ], { selected: 1, refreshMs: 20_000, tab: true });
  }

  // ---- trading -----------------------------------------------------------

  private async quoteBuy(b: Record<string, unknown>): Promise<UiResponse> {
    const mint = this.mintParam(b.mint);
    const sol = parseSolInput(b.sol);
    if (sol > this.cfg.maxSolPerTrade) {
      throw new UserError(`Max per trade is ${this.cfg.maxSolPerTrade} SOL (maxSolPerTrade in config).`);
    }
    const { quote, state } = await this.d.engine.quoteBuy(mint, this.me, solToLamports(sol));
    const meta = await this.d.meta.resolve(mint).catch(() => ({ symbol: undefined }));
    const sym = ticker(meta.symbol, mint.toBase58());
    const id = this.quotes.put({ kind: "buy", quote, symbol: sym });
    const rows: Row[] = [
      info(`Buy ${sym}`, Icon.Bawsaq, { kind: "coinHero", mint: mint.toBase58(), symbol: sym, address: shortAddr(mint.toBase58()) }),
      stat("Spend up to", this.solAndUsd(sol)),
      stat("Get about", `${fmtCompact(rawToUi(quote.expectedTokensRaw, quote.decimals))} ${sym}`),
      stat("At least", `${fmtCompact(rawToUi(quote.minTokensRaw, quote.decimals))} (${this.d.engine.slippagePercent}% slip)`),
      stat("Via", state.venue === "curve" ? "pump.fun curve" : "PumpSwap"),
      ...this.dryRunRows(),
    ];
    return { nav: "push", screen: this.confirmScreen("Confirm buy", rows, "BUY", id, BUY) };
  }

  private async quoteSell(b: Record<string, unknown>): Promise<UiResponse> {
    const mint = this.mintParam(b.mint);
    const percent = Number(b.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new UserError("Sell percent must be 1-100.");
    const { quote, state } = await this.d.engine.quoteSell(mint, this.me, percent);
    const meta = await this.d.meta.resolve(mint).catch(() => ({ symbol: undefined }));
    const sym = ticker(meta.symbol, mint.toBase58());
    const id = this.quotes.put({ kind: "sell", quote, symbol: sym });
    const rows: Row[] = [
      info(`Sell ${percent}% of ${sym}`, Icon.Attachment, { kind: "coinHero", mint: mint.toBase58(), symbol: sym, name: `Sell ${percent}%`, address: shortAddr(mint.toBase58()) }),
      stat("Amount", `${fmtCompact(rawToUi(quote.tokenAmountRaw, quote.decimals))} tokens`),
      stat("Get about", this.solAndUsd(lamportsToSol(quote.expectedLamports))),
      stat("At least", `${fmtSol(lamportsToSol(quote.minLamports))} SOL (${this.d.engine.slippagePercent}% slip)`),
      stat("Via", state.venue === "curve" ? "pump.fun curve" : "PumpSwap"),
      ...this.dryRunRows(),
    ];
    return { nav: "push", screen: this.confirmScreen("Confirm sell", rows, "SELL", id, SELL) };
  }

  private dryRunRows(): Row[] {
    return this.cfg.dryRun ? [info("PRACTICE: simulate only", Icon.Lock, WARN)] : [];
  }

  /** Info rows, then Cancel, then the confirm row. The highlight starts on
   * Cancel, so mashing Select never confirms a trade by accident. */
  private confirmScreen(header: string, rows: Row[], verb: string, quoteId: string, tone: RowStyle): Screen {
    const all = [
      ...rows,
      stat("Valid for", `${this.cfg.quoteTtlSeconds}s`),
      row("Cancel", Icon.RemoveTag, { kind: "back" }, PLAIN),
      row(this.cfg.dryRun ? `SIMULATE ${verb}` : `CONFIRM ${verb}`, Icon.Ticked, post("/ui/execute", { quoteId }), tone),
    ];
    return screen("", header, all, { selected: all.length - 2 });
  }

  private async execute(b: Record<string, unknown>): Promise<UiResponse> {
    const pending = this.quotes.take(String(b.quoteId ?? ""));
    if (!pending) {
      return { nav: "back", toast: { text: "That confirm screen expired. Try again.", level: "error" } };
    }
    // One transaction at a time.
    const run = this.queue.then(() => this.run(pending));
    this.queue = run.catch(() => undefined);
    try {
      return await run;
    } catch (e) {
      const msg = e instanceof UserError ? e.message : `Failed: ${(e as Error).message}`;
      if (!(e instanceof UserError)) this.d.log?.(`execute failed: ${(e as Error).stack ?? String(e)}`);
      return { nav: "back", toast: { text: phoneText(msg, 120), level: "error" } };
    }
  }

  private async submit(instructions: TransactionInstruction[], signers: Keypair[], computeUnitLimit: number): Promise<Outcome> {
    const built = await buildTx(this.d.connection, this.me, instructions, signers, {
      computeUnitLimit,
      priorityFeeMicroLamports: this.cfg.priorityFeeMicroLamports,
    });
    if (this.cfg.dryRun) {
      const sim = await simulate(this.d.connection, built);
      if (!sim.ok) throw new UserError(sim.error ?? "Simulation failed.");
      return { simulated: true, units: sim.unitsConsumed };
    }
    const signature = await (this.d.send ?? sendAndConfirm)(this.d.connection, built);
    return { simulated: false, signature };
  }

  private async run(p: Pending): Promise<UiResponse> {
    if (p.kind === "buy") {
      const { instructions, tokens } = await this.d.engine.buildBuy(p.quote, this.me);
      const out = await this.submit(instructions, [this.d.wallet], this.cfg.computeUnitLimit);
      const ui = rawToUi(tokens, p.quote.decimals);
      const sol = lamportsToSol(p.quote.maxSpendLamports);
      this.d.history.append({ ts: Date.now(), kind: "buy", mint: p.quote.mint.toBase58(), symbol: p.symbol, sol, tokens: ui, signature: out.signature, simulated: out.simulated });
      return this.result(out, out.simulated ? "Simulated buy" : "Bought", [`${fmtCompact(ui)} ${p.symbol}`, `for up to ${fmtSol(sol)} SOL`]);
    }
    if (p.kind === "sell") {
      const { instructions, lamports } = await this.d.engine.buildSell(p.quote, this.me);
      const out = await this.submit(instructions, [this.d.wallet], this.cfg.computeUnitLimit);
      const ui = rawToUi(p.quote.tokenAmountRaw, p.quote.decimals);
      const sol = lamportsToSol(lamports);
      this.d.history.append({ ts: Date.now(), kind: "sell", mint: p.quote.mint.toBase58(), symbol: p.symbol, sol, tokens: ui, signature: out.signature, simulated: out.simulated });
      return this.result(out, out.simulated ? "Simulated sell" : "Sold", [`${fmtCompact(ui)} ${p.symbol}`, `for about ${fmtSol(sol)} SOL`]);
    }
    if (p.kind === "swap") return this.runSwap(p);
    return this.runLaunch(p);
  }

  private result(out: Outcome, header: string, lines: string[], extra: Row[] = []): UiResponse {
    const rows: Row[] = lines.map((l) => info(l, Icon.Ticked));
    if (out.simulated) {
      rows.push(info("Simulation OK. Nothing sent.", Icon.None, WARN));
      if (out.units) rows.push(stat("Compute used", fmtCompact(out.units)));
    } else if (out.signature) {
      rows.push(stat("Tx", shortAddr(out.signature)));
    }
    rows.push(...extra, row("Done", Icon.Ticked, { kind: "back" }, PRIMARY));
    return {
      nav: "replace",
      screen: screen("", header, rows, { selected: rows.length - 1 }),
      toast: { text: `${header}: ${lines.join(" ")}`, level: "success" },
    };
  }

  // ---- launch ------------------------------------------------------------

  launchScreen(): Screen {
    const d = this.draft;
    const presets = this.cfg.launchBuyPresetsSol;
    const buy = presets[d.buyIndex % presets.length];
    const set = (field: string, title: string, maxLength: number, initial: string): Action => ({
      kind: "input",
      title,
      maxLength,
      initial,
      path: "/ui/launch/set",
      field: "value",
      body: { field },
    });
    const field = (label: string, value: string): RowStyle => ({ kind: "nav", label, value: phoneText(value, 24) });
    const rows = [
      info(d.name || "Your coin", Icon.None, {
        kind: "coinPreview",
        name: d.name || "Coin name",
        symbol: d.symbol ? `$${d.symbol}` : "$TICKER",
        detail: phoneText(d.description, 90) || undefined,
        image: d.image ?? undefined,
      }),
      row(`Photo: ${d.image ? "retake" : "open camera"}`, Icon.Camera, { kind: "photo", path: "/ui/launch/set", field: "value", body: { field: "image" } }, field("Photo", d.image ? "Retake" : "Open camera")),
      row(`Name: ${d.name || "(set name)"}`, Icon.Email, set("name", "Coin name (max 32)", 32, d.name), field("Name", d.name || "Set name")),
      row(`Ticker: ${d.symbol || "(set ticker)"}`, Icon.Email, set("symbol", "Ticker (max 10)", 10, d.symbol), field("Ticker", d.symbol || "Set ticker")),
      row(`About: ${d.description || "(optional)"}`, Icon.Email, set("description", "Description (optional)", 200, d.description), field("About", d.description || "Optional")),
      row(`First buy: ${buy === 0 ? "none" : fmtSol(buy) + " SOL"}`, Icon.Bawsaq, post("/ui/launch/next-buy"), field("First buy", buy === 0 ? "None" : `${fmtSol(buy)} SOL`)),
      row("Review", Icon.Party, post("/ui/launch/review"), PRIMARY),
      row("Use newest image file", Icon.Attachment, post("/ui/launch/latest-image"), NAV),
      row("Clear", Icon.RemoveTag, post("/ui/launch/reset"), PLAIN),
    ];
    // The highlight waits on whatever the coin still needs.
    const next = !d.image ? "Photo" : !d.name ? "Name" : !d.symbol ? "Ticker" : "Review";
    return screen("/ui/launch", "Create coin", rows, { selected: rows.findIndex((r) => r.text.startsWith(next)) });
  }

  private launchSet(b: Record<string, unknown>): UiResponse {
    const field = String(b.field ?? "");
    const raw = typeof b.value === "string" ? b.value : "";
    const clean = raw.replace(/[~\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
    switch (field) {
      case "name":
        if (clean.length < 1 || clean.length > 32) throw new UserError("Name must be 1-32 characters.");
        this.draft.name = clean;
        break;
      case "symbol": {
        const sym = clean.replace(/^\$/, "").replace(/\s/g, "").toUpperCase();
        if (!/^[A-Z0-9]{1,10}$/.test(sym)) throw new UserError("Ticker: 1-10 letters or digits.");
        this.draft.symbol = sym;
        break;
      }
      case "description":
        if (clean.length > 300) throw new UserError("Description is too long (max 300).");
        this.draft.description = clean;
        break;
      case "image":
        this.draft.image = resolveImage(raw, this.d.imagesDir).name;
        break;
      default:
        throw new UserError("Unknown field.");
    }
    return { nav: "replace", screen: this.launchScreen(), toast: { text: "Saved", level: "info" } };
  }

  private launchLatestImage(): UiResponse {
    const name = latestImage(this.d.imagesDir);
    if (!name) {
      throw new UserError("No images in the RUGR images folder yet. Take a photo instead.");
    }
    this.draft.image = name;
    return { nav: "replace", screen: this.launchScreen(), toast: { text: `Using ${name}`, level: "info" } };
  }

  private async launchReview(): Promise<UiResponse> {
    const d = { ...this.draft };
    if (!d.name) throw new UserError("Set a name first.");
    if (!d.symbol) throw new UserError("Set a ticker first.");
    if (!d.image) throw new UserError("Add a photo first (pump.fun requires an image).");
    resolveImage(d.image, this.d.imagesDir);
    const sol = this.cfg.launchBuyPresetsSol[d.buyIndex % this.cfg.launchBuyPresetsSol.length];
    if (sol > this.cfg.maxLaunchBuySol) throw new UserError(`First buy is capped at ${this.cfg.maxLaunchBuySol} SOL.`);
    const lamports = solToLamports(sol);
    const balance = await this.d.engine.solBalance(this.me);
    if (balance.lt(lamports.add(LAUNCH_RESERVE_LAMPORTS))) {
      throw new UserError(`Not enough SOL: need about ${fmtSol(sol + 0.03)} SOL, have ${fmtSol(lamportsToSol(balance))}.`);
    }
    const expected = await this.d.engine.quoteLaunchTokens(lamports);
    const id = this.quotes.put({ kind: "launch", draft: d, initialBuyLamports: lamports, expectedTokens: expected });
    const rows: Row[] = [
      info(`Create $${d.symbol}`, Icon.Party, { kind: "coinHero", mint: this.me.toBase58(), symbol: `$${d.symbol}`, name: d.name, address: "New coin", image: d.image! }),
      sol === 0 ? info("No first buy") : stat("First buy", `${fmtSol(sol)} SOL (about ${fmtCompact(rawToUi(expected, 6))})`),
      ...(sol === 0 ? [] : [info("Bought the moment the coin exists")]),
      info("Plus rent and network fees"),
      info("Coins are permanent", Icon.None, WARN),
      ...this.dryRunRows(),
    ];
    return { nav: "push", screen: this.confirmScreen("Confirm create", rows, "CREATE", id, PRIMARY) };
  }

  /**
   * Creates the coin, lists it on RUGR, then makes the first buy as its own transaction: the two together
   * are too big for one. If the buy fails, the coin is still made and its page can buy.
   */
  private async runLaunch(p: Extract<Pending, { kind: "launch" }>): Promise<UiResponse> {
    const { draft } = p;
    const sym = `$${draft.symbol}`;
    // In Practice nothing leaves the PC, so the picture isn't uploaded either.
    const upload = this.d.upload ?? ((input: MetadataInput) => this.d.api.upload(input));
    const uri = this.cfg.dryRun
      ? DRY_RUN_URI
      : await upload({ image: resolveImage(draft.image!, this.d.imagesDir), name: draft.name, symbol: draft.symbol, description: draft.description });
    const { instructions, mint } = await this.d.engine.buildLaunch({ user: this.me, name: draft.name, symbol: draft.symbol, uri });
    const out = await this.submit(instructions, [this.d.wallet, mint], this.cfg.launchComputeUnitLimit);
    const m = mint.publicKey.toBase58();
    this.d.history.append({ ts: Date.now(), kind: "launch", mint: m, symbol: sym, sol: 0, tokens: 0, signature: out.signature, simulated: out.simulated });
    const lines = [sym, `Mint ${shortAddr(m)}`];
    if (out.simulated) {
      if (!p.initialBuyLamports.isZero()) lines.push("First buy runs after the create");
      return this.result(out, "Simulated create", lines);
    }

    this.d.watchlist.set(m, true);
    this.d.meta.remember(m, { name: draft.name, symbol: draft.symbol });
    this.draft = PhoneApp.emptyDraft();
    void this.d.api.register(out.signature!).then((listed) => this.d.log?.(`launch ${m}: ${listed ? "listed on RUGR" : "not listed yet; the server will find it"}`));
    if (!p.initialBuyLamports.isZero()) {
      try {
        const { quote } = await this.d.engine.quoteBuy(mint.publicKey, this.me, p.initialBuyLamports);
        const { instructions: buy, tokens } = await this.d.engine.buildBuy(quote, this.me);
        const bought = await this.submit(buy, [this.d.wallet], this.cfg.computeUnitLimit);
        const ui = rawToUi(tokens, quote.decimals);
        this.d.history.append({ ts: Date.now(), kind: "buy", mint: m, symbol: sym, sol: lamportsToSol(quote.maxSpendLamports), tokens: ui, signature: bought.signature, simulated: false });
        lines.push(`First buy: ${fmtCompact(ui)} ${sym}`);
      } catch (e) {
        const why = (e as Error).message;
        this.d.log?.(`first buy after launch failed: ${why}`);
        lines.push("First buy didn't go through", why, "Buy from the coin's page");
      }
    }
    return this.result(out, "Created", lines, [
      row("Open coin page", Icon.Bawsaq, open(`/ui/token?mint=${m}`), NAV),
      row("Show mint address", Icon.EyeFind, post("/ui/show-address", { mint: m }), NAV),
    ]);
  }
}
