import BN from "bn.js";
import { AccountInfo, Connection, Keypair, Logs, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { GLOBAL_PDA, PUMP_PROGRAM_ID, bondingCurvePda, getPumpProgram } from "@pump-fun/pump-sdk";
import { SOL_USD_ACCOUNT, SOL_USD_FEED_ID } from "../src/price.js";
import type { RugrCoin } from "../src/rugr.js";

/**
 * A minimal in-memory Solana: enough RPC methods for the companion's code
 * paths, with pump.fun accounts encoded by the SDK's own Anchor coder so the
 * real SDK decoders and instruction builders run against them.
 */
export const program = getPumpProgram(new Connection("http://127.0.0.1:9"));

type IdlType = string | { array?: [IdlType, number]; vec?: IdlType; option?: IdlType; defined?: { name: string } };

function defaults(type: IdlType): unknown {
  const types = new Map<string, unknown>((program.idl.types ?? []).map((t) => [t.name as string, t] as const));
  const walk = (t: IdlType): unknown => {
    if (typeof t === "string") {
      if (t === "bool") return false;
      if (["u8", "u16", "u32", "i8", "i16", "i32"].includes(t)) return 0;
      if (["u64", "u128", "i64", "i128"].includes(t)) return new BN(0);
      if (t === "pubkey") return PublicKey.default;
      if (t === "string") return "";
      throw new Error(`no default for ${t}`);
    }
    if (t.array) return Array.from({ length: t.array[1] }, () => walk(t.array![0]));
    if (t.vec) return [];
    if (t.option) return null;
    if (t.defined) {
      const def = types.get(t.defined.name) as any;
      if (!def) throw new Error(`unknown type ${t.defined.name}`);
      if (def.type.kind === "struct") {
        return Object.fromEntries(def.type.fields.map((f: any) => [f.name, walk(f.type)]));
      }
      if (def.type.kind === "enum") return { [def.type.variants[0].name]: {} };
    }
    throw new Error(`unsupported idl type ${JSON.stringify(t)}`);
  };
  return walk(type);
}

export async function encodeAccount(name: "global" | "bondingCurve", overrides: Record<string, unknown>): Promise<Buffer> {
  const base = defaults({ defined: { name } }) as Record<string, unknown>;
  // Anchor's own encode() uses a fixed 1000-byte buffer and Global is
  // larger than that, so encode through its layout directly.
  const coder = program.coder.accounts as unknown as {
    accountLayouts: Map<string, { layout: { encode(v: unknown, b: Buffer): number } }>;
    accountDiscriminator(name: string): Buffer;
  };
  const buf = Buffer.alloc(4096);
  const len = coder.accountLayouts.get(name)!.layout.encode({ ...base, ...overrides }, buf);
  return Buffer.concat([coder.accountDiscriminator(name), buf.subarray(0, len)]);
}

/** A "Program data:" log line carrying a pump.fun event, as the program logs it. */
export function eventLog(name: "createEvent" | "tradeEvent" | "completeEvent", overrides: Record<string, unknown>): string {
  const coder = program.coder.events as unknown as {
    layouts: Map<string, { discriminator: number[]; layout: { encode(v: unknown, b: Buffer): number } }>;
  };
  const event = coder.layouts.get(name)!;
  const buf = Buffer.alloc(4096);
  const len = event.layout.encode({ ...(defaults({ defined: { name } }) as Record<string, unknown>), ...overrides }, buf);
  return "Program data: " + Buffer.concat([Buffer.from(event.discriminator), buf.subarray(0, len)]).toString("base64");
}

/** A Pyth SOL/USD price account, laid out as on mainnet. */
export function encodeSolPrice(usd: number, publishedMs: number, feedId = SOL_USD_FEED_ID): Buffer {
  const data = Buffer.alloc(134);
  data[40] = 1; // verification level: Full
  Buffer.from(feedId, "hex").copy(data, 41);
  data.writeBigInt64LE(BigInt(Math.round(usd * 1e8)), 73);
  data.writeInt32LE(-8, 89);
  data.writeBigInt64LE(BigInt(Math.floor(publishedMs / 1000)), 93);
  return data;
}

export function seedSolPrice(fc: FakeConnection, usd: number): void {
  fc.set(SOL_USD_ACCOUNT, encodeSolPrice(usd, Date.now()), PublicKey.default);
}

// Real pump.fun launch parameters.
export const GLOBAL_VALUES = {
  initialized: true,
  initialVirtualTokenReserves: new BN("1073000000000000"),
  initialVirtualSolReserves: new BN("30000000000"),
  initialRealTokenReserves: new BN("793100000000000"),
  tokenTotalSupply: new BN("1000000000000000"),
  initialVirtualQuoteReserves: new BN("30000000000"),
  feeBasisPoints: new BN(95),
  creatorFeeBasisPoints: new BN(5),
  createV2Enabled: true,
};

export class FakeConnection {
  accounts = new Map<string, AccountInfo<Buffer>>();
  lamports = new Map<string, number>();
  simulated: VersionedTransaction[] = [];
  simulateError: unknown = null;
  /** What a simulation says the wallet holds afterwards; unchanged if not set. */
  lamportsAfterSimulation: number | undefined;
  private logListeners = new Map<number, (l: Logs) => void>();
  private nextListener = 1;

  onLogs(_program: PublicKey, callback: (l: Logs) => void): number {
    const id = this.nextListener++;
    this.logListeners.set(id, callback);
    return id;
  }

  async removeOnLogsListener(id: number): Promise<void> {
    this.logListeners.delete(id);
  }

  get logListenerCount(): number {
    return this.logListeners.size;
  }

  emitLogs(logs: string[], err: unknown = null): void {
    for (const cb of this.logListeners.values()) cb({ err, logs, signature: "fake" } as Logs);
  }

  set(key: PublicKey, data: Buffer, owner: PublicKey, lamports = 2_000_000): void {
    this.accounts.set(key.toBase58(), { data, owner, lamports, executable: false, rentEpoch: 0 });
  }

  async getAccountInfo(key: PublicKey): Promise<AccountInfo<Buffer> | null> {
    return this.accounts.get(key.toBase58()) ?? null;
  }

  async getMultipleAccountsInfo(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    return keys.map((k) => this.accounts.get(k.toBase58()) ?? null);
  }

  async getBalance(key: PublicKey): Promise<number> {
    return this.lamports.get(key.toBase58()) ?? 0;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 };
  }

  async simulateTransaction(tx: VersionedTransaction, opts?: { accounts?: { addresses: string[] } }) {
    this.simulated.push(tx);
    const accounts = opts?.accounts?.addresses.map((a) => ({ lamports: this.lamportsAfterSimulation ?? this.lamports.get(a) ?? 0 }));
    return { context: { slot: 1 }, value: { err: this.simulateError, logs: ["Program log: fake"], unitsConsumed: 61_234, accounts } };
  }

  async getParsedTokenAccountsByOwner(owner: PublicKey, filter: { programId: PublicKey }) {
    const value = [...this.accounts.values()]
      .filter((a) => a.owner.equals(filter.programId) && a.data.length === ACCOUNT_SIZE)
      .map((a) => AccountLayout.decode(a.data))
      .filter((t) => t.owner.equals(owner))
      .map((t) => ({
        account: { data: { parsed: { info: { mint: t.mint.toBase58(), tokenAmount: { amount: t.amount.toString(), decimals: 6 } } } } },
      }));
    return { context: { slot: 1 }, value };
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

export function encodeMint(supply: bigint, decimals = 6): Buffer {
  const buf = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    buf,
  );
  return buf;
}

export function encodeTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const buf = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: BigInt(0),
      delegatedAmount: BigInt(0),
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    buf,
  );
  return buf;
}

/** Answers Jupiter's order requests locally. Change `opts` between calls to change the next answer. */
export function fakeJupiterFetch(taker: PublicKey, opts: { outAmount?: string; payer?: PublicKey; priceImpact?: number; error?: string } = {}): typeof fetch {
  return (async (url: string | URL) => {
    if (opts.error) return new Response(JSON.stringify({ error: opts.error }), { status: 400 });
    const amount = new URL(String(url)).searchParams.get("amount");
    const out = opts.outAmount ?? "1000000000000";
    const message = new TransactionMessage({
      payerKey: opts.payer ?? taker,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [],
    }).compileToV0Message();
    return new Response(JSON.stringify({
      inAmount: amount,
      outAmount: out,
      otherAmountThreshold: new BN(out).muln(9).divn(10).toString(),
      priceImpact: opts.priceImpact ?? 0.12,
      transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"),
      lastValidBlockHeight: 1000,
    }), { status: 200 });
  }) as typeof fetch;
}

const LOGOS = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Jupiter's token list, for the tokens the screens ask about most. */
export const FAKE_TOKENS: Record<string, Record<string, unknown>> = {
  [SOL]: { symbol: "SOL", name: "Wrapped SOL", icon: `${LOGOS}/${SOL}/logo.png`, isVerified: true, usdPrice: 95.82, stats24h: { priceChange: 4.76 } },
  [USDC]: { symbol: "USDC", name: "USD Coin", icon: `${LOGOS}/${USDC}/logo.png`, isVerified: true, usdPrice: 1, stats24h: { priceChange: 0.01 } },
  [USDT]: { symbol: "USDT", name: "Tether USD", icon: `${LOGOS}/${USDT}/logo.svg`, isVerified: true, usdPrice: 0.9998, stats24h: { priceChange: -0.02 } },
};

export function fakeTokensFetch(
  tokens: Record<string, Record<string, unknown>> = FAKE_TOKENS,
  lists: { trending?: Record<string, unknown>[]; recent?: Record<string, unknown>[]; status?: number } = {},
): typeof fetch {
  return (async (url: string | URL) => {
    const { pathname, searchParams } = new URL(String(url));
    if (lists.status) return new Response("{}", { status: lists.status });
    if (pathname.includes("/toptrending/")) return new Response(JSON.stringify(lists.trending ?? []), { status: 200 });
    if (pathname.endsWith("/recent")) return new Response(JSON.stringify(lists.recent ?? []), { status: 200 });
    const ids = (searchParams.get("query") ?? "").split(",");
    return new Response(JSON.stringify(ids.filter((id) => tokens[id]).map((id) => ({ id, ...tokens[id] }))), { status: 200 });
  }) as typeof fetch;
}

/**
 * RUGR's server, for tests and the simulator: these coins in Trending and New, uploads that return a link,
 * and launches that list themselves. Pass `down` to have it unreachable.
 */
export function fakeRugrFetch(
  coins: () => RugrCoin[] = () => [],
  opts: { down?: boolean; uploads?: Record<string, unknown>[]; registered?: string[] } = {},
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    if (opts.down) throw new Error("offline");
    const { pathname, searchParams } = new URL(String(url));
    const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (pathname === "/coins") {
      const list = [...coins()];
      if (searchParams.get("kind") === "new") list.sort((a, b) => b.createdMs - a.createdMs);
      return new Response(JSON.stringify({ coins: list }), { status: 200 });
    }
    if (pathname === "/launch/upload") {
      opts.uploads?.push(body());
      return new Response(JSON.stringify({ uri: `https://rugr.test/m/${"a".repeat(40)}.json` }), { status: 200 });
    }
    if (pathname === "/launch/register") {
      opts.registered?.push(String(body().signature));
      return new Response(JSON.stringify({ listed: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

/** A chain with pump.fun's Global and one SPL-token coin part-way up its curve. */
export async function seedChain(
  fc: FakeConnection,
  user: PublicKey,
  opts: { userLamports?: number; holdTokens?: bigint; graduatedAway?: boolean; mayhem?: boolean; realQuoteLamports?: number } = {},
) {
  const feeRecipient = Keypair.generate().publicKey;
  const recipients = Array.from({ length: 7 }, () => Keypair.generate().publicKey);
  const buyback = Array.from({ length: 8 }, () => Keypair.generate().publicKey);
  fc.set(
    GLOBAL_PDA,
    await encodeAccount("global", {
      ...GLOBAL_VALUES,
      feeRecipient,
      feeRecipients: recipients,
      reservedFeeRecipient: feeRecipient,
      reservedFeeRecipients: recipients,
      buybackFeeRecipients: buyback,
    }),
    PUMP_PROGRAM_ID,
  );
  const mint = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  // ~30% sold: virtual reserves moved along x*y=k from the launch values.
  const vt = new BN("750000000000000");
  const vq = new BN("30000000000").mul(new BN("1073000000000000")).div(vt);
  fc.set(
    bondingCurvePda(mint),
    await encodeAccount("bondingCurve", {
      // A curve whose coin has moved on is emptied and has no PumpSwap pool here.
      virtualTokenReserves: opts.graduatedAway ? new BN(0) : vt,
      virtualQuoteReserves: opts.graduatedAway ? new BN(0) : vq,
      realTokenReserves: opts.graduatedAway ? new BN(0) : new BN("793100000000000").sub(new BN("1073000000000000").sub(vt)),
      realQuoteReserves: opts.graduatedAway ? new BN(0) : opts.realQuoteLamports !== undefined ? new BN(opts.realQuoteLamports) : vq.sub(new BN("30000000000")),
      tokenTotalSupply: new BN("1000000000000000"),
      complete: Boolean(opts.graduatedAway),
      isMayhemMode: Boolean(opts.mayhem),
      creator,
      quoteMint: PublicKey.default,
      initialVirtualQuoteReserves: new BN("30000000000"),
    }),
    PUMP_PROGRAM_ID,
  );
  fc.set(mint, encodeMint(BigInt("1000000000000000")), TOKEN_PROGRAM_ID);
  fc.lamports.set(user.toBase58(), opts.userLamports ?? 2_000_000_000);
  if (opts.holdTokens) {
    const ata = getAssociatedTokenAddressSync(mint, user, true, TOKEN_PROGRAM_ID);
    fc.set(ata, encodeTokenAccount(mint, user, opts.holdTokens), TOKEN_PROGRAM_ID);
  }
  return { mint, creator };
}

/** Decodes every pump.fun instruction in a transaction. */
export function pumpInstructions(tx: VersionedTransaction): { name: string; data: Record<string, any> }[] {
  const keys = tx.message.staticAccountKeys;
  const out: { name: string; data: Record<string, any> }[] = [];
  for (const ix of tx.message.compiledInstructions) {
    if (!keys[ix.programIdIndex].equals(PUMP_PROGRAM_ID)) continue;
    const coder = program.coder.instruction as unknown as { decode(b: Buffer): { name: string; data: Record<string, any> } | null };
    const decoded = coder.decode(Buffer.from(ix.data));
    if (decoded) out.push(decoded as { name: string; data: Record<string, any> });
  }
  return out;
}
