import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

export interface TxOptions {
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
}

export interface BuiltTx {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** An error whose message is fine to show on the phone as-is. */
export class UserError extends Error {}

export async function buildTx(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  opts: TxOptions,
): Promise<BuiltTx> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit })];
  if (opts.priorityFeeMicroLamports > 0) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityFeeMicroLamports }));
  }
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...budget, ...instructions],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign(signers);
  return { tx, blockhash, lastValidBlockHeight };
}

export interface SimulationResult {
  ok: boolean;
  error?: string;
  logs: string[];
  unitsConsumed?: number;
}

export async function simulate(connection: Connection, built: BuiltTx): Promise<SimulationResult> {
  const res = await connection.simulateTransaction(built.tx, {
    sigVerify: true,
    commitment: "processed",
  });
  const logs = res.value.logs ?? [];
  if (res.value.err) {
    return { ok: false, error: explainFailure(res.value.err, logs), logs, unitsConsumed: res.value.unitsConsumed };
  }
  return { ok: true, logs, unitsConsumed: res.value.unitsConsumed };
}

const CONFIRM_POLL_MS = 1_000;
const RESEND_EVERY = 3; // polls
const MAX_POLLS = 120; // a blockhash runs out well before this

/**
 * Sends with preflight (the RPC simulates first and refuses a failing tx), then waits for confirmation by
 * asking for the status every second. That works through any RPC, RUGR's included, without the WebSocket
 * that web3.js's own confirm needs. Until it lands it's sent again every few seconds, which helps it through
 * a busy network; it's the same signed transaction, so it can only land once.
 */
export async function sendAndConfirm(
  connection: Connection,
  built: BuiltTx,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const raw = built.tx.serialize();
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 3,
    });
  } catch (e) {
    const logs: string[] = (e as { logs?: string[] }).logs ?? [];
    throw new UserError(explainFailure((e as Error).message, logs));
  }
  const landed = async (history: boolean) => {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: history }).catch(() => null))?.value[0];
    if (status?.err) throw new UserError(`Transaction failed on-chain (${signature.slice(0, 8)}..): ${JSON.stringify(status.err)}`);
    return status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
  };
  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    await sleep(CONFIRM_POLL_MS);
    if (await landed(false)) return signature;
    if (poll % RESEND_EVERY !== 0) continue;
    const height = await connection.getBlockHeight("confirmed").catch(() => 0);
    if (height > built.lastValidBlockHeight) {
      // Its blockhash has run out, so it can't land any more; one last look in case it already did.
      if (await landed(true)) return signature;
      throw new UserError("Network was too slow; the transaction expired. Nothing was spent. Try again.");
    }
    await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
  }
  if (await landed(true)) return signature;
  throw new UserError(`Couldn't confirm it in time (${signature.slice(0, 8)}..). Check your wallet before trying again.`);
}

// Anchor error names from the pump / pump-amm IDLs that a trader can hit,
// mapped to something readable on a phone screen.
const FRIENDLY: [RegExp, string][] = [
  [/TooMuchSolRequired|ExceededSlippage|TooMuchQuoteRequired/i, "Price moved up past your slippage. Try again."],
  [/TooLittleSolReceived|TooLittleQuoteReceived/i, "Price moved down past your slippage. Try again."],
  [/BondingCurveComplete/i, "This token just graduated. Refresh and trade again."],
  [/Error Code: Overflow/, "This curve can't pay out that much. Try selling less."],
  [/insufficient lamports|InsufficientFunds|insufficient funds|0x1\b/i, "Not enough SOL for this trade plus fees."],
  [/Blockhash not found|block height exceeded/i, "Network was too slow; the transaction expired. Try again."],
  [/AccountNotFound|could not find account/i, "Wallet has no SOL yet. Fund it first."],
];

export function explainFailure(err: unknown, logs: string[]): string {
  const haystack = [typeof err === "string" ? err : JSON.stringify(err), ...logs].join("\n");
  for (const [re, msg] of FRIENDLY) if (re.test(haystack)) return msg;
  const anchor = /Error Code: (\w+)/.exec(haystack);
  if (anchor) return `Rejected by program: ${anchor[1]}`;
  return "Transaction would fail: " + haystack.split("\n")[0].slice(0, 120);
}

export function parsePublicKey(s: string): PublicKey | null {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim())) return null;
  try {
    return new PublicKey(s.trim());
  } catch {
    return null;
  }
}
