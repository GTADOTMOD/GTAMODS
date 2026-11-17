import BN from "bn.js";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { BuiltTx, UserError, explainFailure } from "./solana.js";

/**
 * Swaps for any Solana token, through Jupiter's routing. Jupiter builds the
 * transaction, so nothing here takes it on trust: the fee payer must be our
 * wallet, and a simulation must show it spending no more SOL than the player
 * agreed to, before it can be sent.
 */
export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const ORDER_URL = "https://api.jup.ag/swap/v2/order";

export interface SwapRequest {
  inputMint: string;
  outputMint: string;
  amount: BN;
  taker: PublicKey;
  slippageBps: number;
}

export interface SwapOrder {
  inAmount: BN;
  outAmount: BN;
  minOut: BN;
  priceImpactPct: number;
  transaction?: string;
  lastValidBlockHeight?: number;
  /** Why there's no transaction, if Jupiter said. */
  problem?: string;
}

export class Jupiter {
  constructor(
    private fetchImpl: typeof fetch = fetch,
    private apiKey = "",
  ) {}

  async order(req: SwapRequest): Promise<SwapOrder> {
    const url = new URL(ORDER_URL);
    url.searchParams.set("inputMint", req.inputMint);
    url.searchParams.set("outputMint", req.outputMint);
    url.searchParams.set("amount", req.amount.toString());
    url.searchParams.set("taker", req.taker.toBase58());
    url.searchParams.set("slippageBps", String(req.slippageBps));
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: this.apiKey ? { "x-api-key": this.apiKey } : {},
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new UserError("Couldn't reach the swap service. Try again.");
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 429) throw new UserError("Swap service is busy. Try again in a moment.");
    if (!res.ok) {
      const reason = String(body.error ?? "");
      if (/route|liquidity/i.test(reason)) throw new UserError("No way to swap this token right now.");
      if (/not a valid token/i.test(reason)) throw new UserError("That isn't a token address.");
      throw new UserError("The swap service refused this swap.");
    }
    if (typeof body.outAmount !== "string" || typeof body.otherAmountThreshold !== "string") {
      throw new UserError("No way to swap this token right now.");
    }
    return {
      inAmount: new BN(String(body.inAmount)),
      outAmount: new BN(body.outAmount),
      minOut: new BN(body.otherAmountThreshold),
      priceImpactPct: Math.abs(Number(body.priceImpact ?? 0)),
      transaction: typeof body.transaction === "string" && body.transaction ? body.transaction : undefined,
      lastValidBlockHeight: body.lastValidBlockHeight === undefined ? undefined : Number(body.lastValidBlockHeight),
      problem: typeof body.errorMessage === "string" ? body.errorMessage : undefined,
    };
  }
}

/** Signs Jupiter's transaction, if our wallet is the one paying for it. */
export function signSwap(transaction: string, lastValidBlockHeight: number, wallet: Keypair): BuiltTx {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  } catch {
    throw new UserError("The swap service sent a bad transaction. Nothing was sent.");
  }
  if (!tx.message.staticAccountKeys[0]?.equals(wallet.publicKey)) {
    throw new UserError("The swap service sent a transaction for another wallet. Nothing was sent.");
  }
  tx.sign([wallet]);
  return { tx, blockhash: tx.message.recentBlockhash, lastValidBlockHeight };
}

export interface SwapCheck {
  ok: boolean;
  error?: string;
  unitsConsumed?: number;
}

/** Simulates the signed swap, and fails it if our wallet would lose more SOL than allowed. */
export async function checkSwap(connection: Connection, built: BuiltTx, wallet: PublicKey, maxLamportsSpent: BN): Promise<SwapCheck> {
  const before = await connection.getBalance(wallet, "confirmed");
  const res = await connection.simulateTransaction(built.tx, {
    sigVerify: true,
    commitment: "processed",
    accounts: { encoding: "base64", addresses: [wallet.toBase58()] },
  });
  const logs = res.value.logs ?? [];
  if (res.value.err) return { ok: false, error: explainFailure(res.value.err, logs), unitsConsumed: res.value.unitsConsumed };
  const after = res.value.accounts?.[0]?.lamports;
  if (after === undefined) return { ok: false, error: "Couldn't check this swap. Nothing was sent." };
  if (new BN(before).sub(new BN(after)).gt(maxLamportsSpent)) {
    return { ok: false, error: "This swap would take more SOL than it showed. Nothing was sent." };
  }
  return { ok: true, unitsConsumed: res.value.unitsConsumed };
}
