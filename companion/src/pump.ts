import BN from "bn.js";
import { AccountInfo, Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  BondingCurve,
  FeeConfig,
  Global,
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  canonicalPumpPoolPda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  isBondingCurveMigrated,
  isSolLikeQuoteMint,
} from "@pump-fun/pump-sdk";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  SwapSolanaState,
  buyQuoteInput,
  poolMarketCap,
  sellBaseInput,
} from "@pump-fun/pump-sdk/swap";
import { LAMPORTS_PER_SOL } from "./format.js";
import { launchReferenceInstruction } from "./rugr.js";
import { UserError } from "./solana.js";

/**
 * Everything that touches pump.fun's programs. Two venues:
 *  - "curve":    the bonding curve, while a coin is still on pump.fun
 *  - "pumpswap": the canonical PumpSwap pool, once the curve completed
 * Only SOL-quoted coins are supported (the default on pump.fun).
 *
 * Slippage is applied so that what the confirm screen promises is what the
 * chain enforces: a buy never spends more than the amount the player picked,
 * and a sell never returns less than the minimum shown.
 */
export type Venue = "curve" | "pumpswap";

export interface TokenState {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  venue: Venue;
  curve: BondingCurve;
  /** pump.fun "Mayhem mode": the curve can hold far less SOL than the price
   * implies, so a big enough sale can't be paid out. PumpV never lists or
   * buys these, but can still sell one the wallet already holds. */
  mayhem: boolean;
  /** 0-100 while on the curve, null after graduation. */
  progressPct: number | null;
  /** SOL per whole token. */
  priceSol: number;
  marketCapSol: number;
  poolKey?: PublicKey;
}

export interface BuyQuote {
  kind: "buy";
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  venue: Venue;
  /** The most SOL that can leave the wallet for the trade itself. */
  maxSpendLamports: BN;
  expectedTokensRaw: BN;
  minTokensRaw: BN;
}

export interface SellQuote {
  kind: "sell";
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  venue: Venue;
  tokenAmountRaw: BN;
  expectedLamports: BN;
  minLamports: BN;
}

export interface Holding {
  mint: PublicKey;
  tokenProgram: PublicKey;
  amountRaw: BN;
  decimals: number;
}

/** A real token, just not one this engine can trade. Swap can still route it. */
export class NotOnPumpError extends UserError {}

export class PriceMovedError extends UserError {
  constructor() {
    super("Price moved beyond your slippage since the quote. Get a new quote.");
  }
}

/** SOL kept back for fees and token-account rent when checking balances. */
export const FEE_RESERVE_LAMPORTS = new BN(5_000_000); // 0.005 SOL

export function slippageTenths(slippagePercent: number): number {
  return Math.max(1, Math.floor(slippagePercent * 10));
}

/** Budget b such that b plus the SDK's slippage allowance never exceeds `cap`. */
export function budgetUnderCap(cap: BN, tenths: number): BN {
  return cap.muln(1000).divn(1000 + tenths);
}

/** a * (1 - slippage), rounded down. */
export function applyMinSlippage(amount: BN, tenths: number): BN {
  return amount.muln(1000 - tenths).divn(1000);
}

/** The `solAmount` to hand the SDK's sell builder so that its slippage
 * deduction lands exactly on `min` (rounded up so it never lands below). */
export function solAmountForMin(min: BN, tenths: number): BN {
  const denom = new BN(1000 - tenths);
  const num = min.muln(1000);
  const q = num.div(denom);
  return num.mod(denom).isZero() ? q : q.addn(1);
}

export function curveProgress(global: Global, curve: BondingCurve): number {
  const initial = global.initialRealTokenReserves;
  if (initial.isZero()) return 0;
  const sold = initial.sub(BN.min(initial, curve.realTokenReserves));
  return Math.min(100, Math.max(0, (Number(sold.muln(10000).div(initial).toString()) / 100)));
}

function ratio(num: BN, den: BN): number {
  if (den.isZero()) return 0;
  // Keep 12 significant digits before going to float.
  const scaled = num.mul(new BN(10).pow(new BN(12))).div(den);
  return Number(scaled.toString()) / 1e12;
}

export class PumpEngine {
  private online: OnlinePumpSdk;
  private amm: OnlinePumpAmmSdk;
  private globalCache?: { at: number; global: Global; feeConfig: FeeConfig | null };
  private tenths: number;

  constructor(
    private connection: Connection,
    slippagePercent: number,
  ) {
    this.online = new OnlinePumpSdk(connection);
    this.amm = new OnlinePumpAmmSdk(connection);
    this.tenths = slippageTenths(slippagePercent);
  }

  get slippagePercent(): number {
    return this.tenths / 10;
  }

  setSlippagePercent(percent: number): void {
    this.tenths = slippageTenths(percent);
  }

  async globals(): Promise<{ global: Global; feeConfig: FeeConfig | null }> {
    if (this.globalCache && Date.now() - this.globalCache.at < 60_000) return this.globalCache;
    const [global, feeConfig] = await Promise.all([
      this.online.fetchGlobal(),
      this.online.fetchFeeConfig().catch(() => null),
    ]);
    this.globalCache = { at: Date.now(), global, feeConfig };
    return this.globalCache;
  }

  async getState(mint: PublicKey, user: PublicKey): Promise<TokenState> {
    const [curveInfo, mintInfo] = await this.connection.getMultipleAccountsInfo([bondingCurvePda(mint), mint]);
    if (!mintInfo) throw new UserError("No token exists at that address.");
    const tokenProgram = mintInfo.owner;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new UserError("That address is not a token mint.");
    }
    if (!curveInfo) throw new NotOnPumpError("Not a pump.fun token.");
    const decimals = unpackMint(mint, mintInfo, tokenProgram).decimals;
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    if (!isSolLikeQuoteMint(curve.quoteMint)) {
      throw new NotOnPumpError("This coin is quoted in a token, not SOL.");
    }
    const { global } = await this.globals();

    if (!curve.complete && !isBondingCurveMigrated(curve)) {
      const priceLamportsPerRaw = ratio(curve.virtualQuoteReserves, curve.virtualTokenReserves);
      const mc = bondingCurveMarketCap({
        mintSupply: curve.tokenTotalSupply,
        virtualQuoteReserves: curve.virtualQuoteReserves,
        virtualTokenReserves: curve.virtualTokenReserves,
      });
      return {
        mint,
        tokenProgram,
        decimals,
        venue: "curve",
        curve,
        mayhem: curve.isMayhemMode,
        progressPct: curveProgress(global, curve),
        priceSol: (priceLamportsPerRaw * 10 ** decimals) / LAMPORTS_PER_SOL,
        marketCapSol: Number(mc.toString()) / LAMPORTS_PER_SOL,
      };
    }

    const poolKey = canonicalPumpPoolPda(mint);
    if ((await this.connection.getAccountInfo(poolKey)) === null) {
      if (isBondingCurveMigrated(curve)) throw new NotOnPumpError("This coin graduated to Raydium or elsewhere.");
      throw new UserError("This coin just graduated. Its PumpSwap pool isn't ready yet.");
    }
    const swap = await this.swapState(poolKey, user);
    const supply = new BN(swap.baseMintAccount.supply.toString());
    const mc = poolMarketCap({
      baseMintSupply: supply,
      baseReserve: swap.poolBaseAmount,
      quoteReserve: swap.poolQuoteAmount,
      isMayhemMode: swap.pool.isMayhemMode,
    });
    return {
      mint,
      tokenProgram,
      decimals,
      venue: "pumpswap",
      curve,
      mayhem: swap.pool.isMayhemMode,
      progressPct: null,
      priceSol: (ratio(swap.poolQuoteAmount, swap.poolBaseAmount) * 10 ** decimals) / LAMPORTS_PER_SOL,
      marketCapSol: Number(mc.toString()) / LAMPORTS_PER_SOL,
      poolKey,
    };
  }

  private async swapState(poolKey: PublicKey, user: PublicKey): Promise<SwapSolanaState> {
    const state = await this.amm.swapSolanaState(poolKey, user);
    if (!state.pool.quoteMint.equals(NATIVE_MINT)) {
      throw new NotOnPumpError("This pool is not quoted in SOL.");
    }
    return state;
  }

  async solBalance(owner: PublicKey): Promise<BN> {
    return new BN(await this.connection.getBalance(owner, "confirmed"));
  }

  async tokenBalance(mint: PublicKey, tokenProgram: PublicKey, owner: PublicKey): Promise<BN> {
    const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
    const info = await this.connection.getAccountInfo(ata, "confirmed");
    if (!info) return new BN(0);
    return new BN(unpackAccount(ata, info, tokenProgram).amount.toString());
  }

  // ---- buy ---------------------------------------------------------------

  async quoteBuy(mint: PublicKey, user: PublicKey, maxSpendLamports: BN): Promise<{ quote: BuyQuote; state: TokenState }> {
    const [state, sol] = await Promise.all([this.getState(mint, user), this.solBalance(user)]);
    if (state.mayhem) throw new UserError("RUGR only buys regular coins, not Mayhem coins.");
    if (sol.lt(maxSpendLamports.add(FEE_RESERVE_LAMPORTS))) {
      throw new UserError(`Not enough SOL: wallet has ${Number(sol.toString()) / LAMPORTS_PER_SOL} SOL.`);
    }
    const built = await this.buyPlan(state, user, maxSpendLamports);
    const quote: BuyQuote = {
      kind: "buy",
      mint,
      tokenProgram: state.tokenProgram,
      decimals: state.decimals,
      venue: state.venue,
      maxSpendLamports,
      expectedTokensRaw: built.tokens,
      minTokensRaw: applyMinSlippage(built.tokens, this.tenths),
    };
    if (quote.expectedTokensRaw.isZero()) throw new UserError("Amount too small to buy anything.");
    return { quote, state };
  }

  /** Fresh instructions for a quote, refusing if the price moved too far. */
  async buildBuy(quote: BuyQuote, user: PublicKey): Promise<{ instructions: TransactionInstruction[]; tokens: BN }> {
    const state = await this.getState(quote.mint, user);
    if (state.venue !== quote.venue) throw new UserError("The token changed venue (graduated). Get a new quote.");
    const plan = await this.buyPlan(state, user, quote.maxSpendLamports);
    if (plan.tokens.lt(quote.minTokensRaw)) throw new PriceMovedError();
    return { instructions: await plan.build(), tokens: plan.tokens };
  }

  private async buyPlan(state: TokenState, user: PublicKey, cap: BN): Promise<{ tokens: BN; build: () => Promise<TransactionInstruction[]> }> {
    const budget = budgetUnderCap(cap, this.tenths);
    if (state.venue === "curve") {
      const { global, feeConfig } = await this.globals();
      const bs = await this.online.fetchBuyState(state.mint, user, state.tokenProgram);
      const tokens = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bs.bondingCurve.tokenTotalSupply,
        bondingCurve: bs.bondingCurve,
        amount: budget,
        quoteMint: bs.quoteMint,
        quoteTransferFee: bs.quoteTransferFee,
      });
      return {
        tokens,
        build: () =>
          PUMP_SDK.buyInstructions({
            global,
            bondingCurveAccountInfo: bs.bondingCurveAccountInfo,
            bondingCurve: bs.bondingCurve,
            associatedUserAccountInfo: bs.associatedUserAccountInfo,
            mint: state.mint,
            user,
            amount: tokens,
            solAmount: budget,
            slippage: this.tenths / 10,
            tokenProgram: state.tokenProgram,
          }),
      };
    }
    const swap = await this.swapState(state.poolKey!, user);
    const { base } = buyQuoteInput({
      quote: budget,
      slippage: this.tenths / 10,
      quoteTransferFee: swap.quoteTransferFee,
      tradeV2: false,
      baseReserve: swap.poolBaseAmount,
      quoteReserve: swap.poolQuoteAmount,
      virtualQuoteReserves: swap.pool.virtualQuoteReserves,
      baseMintAccount: swap.baseMintAccount,
      baseMint: swap.baseMint,
      coinCreator: swap.pool.coinCreator,
      creator: swap.pool.creator,
      feeConfig: swap.feeConfig,
      globalConfig: swap.globalConfig,
      quoteMint: swap.pool.quoteMint,
      isMayhemMode: swap.pool.isMayhemMode,
      creatorFeeBps: swap.pool.creatorFeeBps,
    });
    // Exact output, and the SOL the pool may take is capped at the player's
    // chosen amount itself.
    return { tokens: base, build: () => PUMP_AMM_SDK.buyInstructions(swap, base, cap) };
  }

  // ---- sell --------------------------------------------------------------

  async quoteSell(mint: PublicKey, user: PublicKey, percent: number): Promise<{ quote: SellQuote; state: TokenState }> {
    if (!(percent > 0 && percent <= 100)) throw new UserError("Sell percent must be 1-100.");
    const state = await this.getState(mint, user);
    const balance = await this.tokenBalance(mint, state.tokenProgram, user);
    if (balance.isZero()) throw new UserError("You don't hold this token.");
    const amount = percent >= 100 ? balance : balance.muln(Math.round(percent * 100)).divn(10000);
    if (amount.isZero()) throw new UserError("Amount too small to sell.");
    const expected = await this.estimateSell(state, user, amount);
    if (expected.isZero()) throw new UserError("That sale would return 0 SOL.");
    if (state.venue === "curve" && expected.gt(state.curve.realQuoteReserves)) {
      throw new UserError(`This curve only holds ${Number(state.curve.realQuoteReserves.toString()) / LAMPORTS_PER_SOL} SOL. Try selling less.`);
    }
    return {
      quote: {
        kind: "sell",
        mint,
        tokenProgram: state.tokenProgram,
        decimals: state.decimals,
        venue: state.venue,
        tokenAmountRaw: amount,
        expectedLamports: expected,
        minLamports: applyMinSlippage(expected, this.tenths),
      },
      state,
    };
  }

  async buildSell(quote: SellQuote, user: PublicKey): Promise<{ instructions: TransactionInstruction[]; lamports: BN }> {
    const state = await this.getState(quote.mint, user);
    if (state.venue !== quote.venue) throw new UserError("The token changed venue (graduated). Get a new quote.");
    const balance = await this.tokenBalance(quote.mint, state.tokenProgram, user);
    if (balance.lt(quote.tokenAmountRaw)) throw new UserError("Your balance changed since the quote. Get a new quote.");
    const fresh = await this.estimateSell(state, user, quote.tokenAmountRaw);
    if (fresh.lt(quote.minLamports)) throw new PriceMovedError();

    if (state.venue === "curve") {
      const { global } = await this.globals();
      const ss = await this.online.fetchSellState(quote.mint, user, state.tokenProgram);
      const instructions = await PUMP_SDK.sellInstructions({
        global,
        bondingCurveAccountInfo: ss.bondingCurveAccountInfo,
        bondingCurve: ss.bondingCurve,
        mint: quote.mint,
        user,
        amount: quote.tokenAmountRaw,
        // The builder subtracts slippage from this; this value makes the
        // on-chain minimum equal the minimum shown on the confirm screen.
        solAmount: solAmountForMin(quote.minLamports, this.tenths),
        slippage: this.tenths / 10,
        tokenProgram: state.tokenProgram,
        mayhemMode: ss.bondingCurve.isMayhemMode,
        cashback: ss.bondingCurve.isCashbackCoin,
      });
      return { instructions, lamports: fresh };
    }
    const swap = await this.swapState(state.poolKey!, user);
    return {
      instructions: await PUMP_AMM_SDK.sellInstructions(swap, quote.tokenAmountRaw, quote.minLamports),
      lamports: fresh,
    };
  }

  /** What a holding can really fetch: never more than the curve can pay out. */
  async holdingValue(state: TokenState, user: PublicKey, amount: BN): Promise<BN> {
    const value = await this.estimateSell(state, user, amount);
    return state.venue === "curve" ? BN.min(value, state.curve.realQuoteReserves) : value;
  }

  async estimateSell(state: TokenState, user: PublicKey, amount: BN): Promise<BN> {
    if (state.venue === "curve") {
      const { global, feeConfig } = await this.globals();
      return getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: state.curve.tokenTotalSupply,
        bondingCurve: state.curve,
        amount,
      });
    }
    const swap = await this.swapState(state.poolKey!, user);
    return sellBaseInput({
      base: amount,
      slippage: this.tenths / 10,
      quoteTransferFee: swap.quoteTransferFee,
      baseReserve: swap.poolBaseAmount,
      quoteReserve: swap.poolQuoteAmount,
      virtualQuoteReserves: swap.pool.virtualQuoteReserves,
      feeBucketsTotal: swap.pool.protocolFees.add(swap.pool.creatorFees),
      baseMintAccount: swap.baseMintAccount,
      baseMint: swap.baseMint,
      coinCreator: swap.pool.coinCreator,
      creator: swap.pool.creator,
      feeConfig: swap.feeConfig,
      globalConfig: swap.globalConfig,
      quoteMint: swap.pool.quoteMint,
      isMayhemMode: swap.pool.isMayhemMode,
      creatorFeeBps: swap.pool.creatorFeeBps,
    }).uiQuote;
  }

  // ---- launch ------------------------------------------------------------

  /** Tokens the creator's first buy would get on a brand-new curve. */
  async quoteLaunchTokens(initialBuyLamports: BN): Promise<BN> {
    if (initialBuyLamports.isZero()) return new BN(0);
    const { global, feeConfig } = await this.globals();
    return getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: null,
      amount: budgetUnderCap(initialBuyLamports, 10),
      quoteMint: NATIVE_MINT,
    });
  }

  /**
   * The create, with RUGR's reference attached so the server lists it. The first buy is a second transaction
   * once this one lands: create and buy together come to about 1,700 bytes, and Solana takes 1,232.
   */
  async buildLaunch(params: { user: PublicKey; name: string; symbol: string; uri: string }): Promise<{ instructions: TransactionInstruction[]; mint: Keypair }> {
    const mint = Keypair.generate();
    const create = await PUMP_SDK.createV2Instruction({
      mint: mint.publicKey,
      name: params.name,
      symbol: params.symbol,
      uri: params.uri,
      creator: params.user,
      user: params.user,
      mayhemMode: false,
    });
    return { instructions: [create, launchReferenceInstruction(params.user)], mint };
  }

  /** How far along its curve each coin is, and which are Mayhem coins, from one batched fetch. */
  async curves(mints: string[]): Promise<Map<string, { progressPct: number | null; mayhem: boolean }>> {
    const out = new Map<string, { progressPct: number | null; mayhem: boolean }>();
    if (mints.length === 0) return out;
    const { global } = await this.globals();
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100);
      const infos = await this.connection.getMultipleAccountsInfo(chunk.map((m) => bondingCurvePda(new PublicKey(m))));
      infos.forEach((info, n) => {
        if (!info) return;
        const curve = PUMP_SDK.decodeBondingCurve(info);
        const finished = curve.complete || isBondingCurveMigrated(curve);
        out.set(chunk[n], { progressPct: finished ? null : curveProgress(global, curve), mayhem: curve.isMayhemMode });
      });
    }
    return out;
  }

  // ---- holdings ----------------------------------------------------------

  async holdings(owner: PublicKey): Promise<Holding[]> {
    const out: Holding[] = [];
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await this.connection.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed");
      for (const { account } of res.value) {
        const info = (account.data as { parsed?: { info?: Record<string, any> } }).parsed?.info;
        const amount = info?.tokenAmount?.amount;
        const mint = info?.mint;
        if (typeof amount !== "string" || typeof mint !== "string" || amount === "0") continue;
        out.push({
          mint: new PublicKey(mint),
          tokenProgram: programId,
          amountRaw: new BN(amount),
          decimals: Number(info?.tokenAmount?.decimals ?? 6),
        });
      }
    }
    return out;
  }

  /**
   * SOL value of holdings on the bonding curve, computed from one batched
   * account fetch. Graduated coins are valued from their pool, at most
   * `maxPoolLookups` of them (each costs two RPC round-trips).
   */
  async valueHoldings(owner: PublicKey, holdings: Holding[], maxPoolLookups = 5): Promise<Map<string, { lamports: BN | null; venue: Venue | null }>> {
    const result = new Map<string, { lamports: BN | null; venue: Venue | null }>();
    if (holdings.length === 0) return result;
    const { global, feeConfig } = await this.globals();
    const infos: (AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < holdings.length; i += 100) {
      const chunk = holdings.slice(i, i + 100).map((h) => bondingCurvePda(h.mint));
      infos.push(...(await this.connection.getMultipleAccountsInfo(chunk)));
    }
    let poolLookups = 0;
    for (let i = 0; i < holdings.length; i++) {
      const h = holdings[i];
      const info = infos[i];
      const key = h.mint.toBase58();
      if (!info) {
        result.set(key, { lamports: null, venue: null });
        continue;
      }
      const curve = PUMP_SDK.decodeBondingCurve(info);
      if (!isSolLikeQuoteMint(curve.quoteMint)) {
        result.set(key, { lamports: null, venue: null });
      } else if (!curve.complete && !isBondingCurveMigrated(curve)) {
        const lamports = getSellSolAmountFromTokenAmount({
          global,
          feeConfig,
          mintSupply: curve.tokenTotalSupply,
          bondingCurve: curve,
          amount: h.amountRaw,
        });
        result.set(key, { lamports: BN.min(lamports, curve.realQuoteReserves), venue: "curve" });
      } else if (poolLookups < maxPoolLookups) {
        poolLookups++;
        try {
          const state: TokenState = {
            mint: h.mint,
            tokenProgram: h.tokenProgram,
            decimals: h.decimals,
            venue: "pumpswap",
            curve,
            mayhem: false,
            progressPct: null,
            priceSol: 0,
            marketCapSol: 0,
            poolKey: canonicalPumpPoolPda(h.mint),
          };
          result.set(key, { lamports: await this.estimateSell(state, owner, h.amountRaw), venue: "pumpswap" });
        } catch {
          result.set(key, { lamports: null, venue: "pumpswap" });
        }
      } else {
        result.set(key, { lamports: null, venue: "pumpswap" });
      }
    }
    return result;
  }
}
