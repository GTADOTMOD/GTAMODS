import fs from "node:fs";
import path from "node:path";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { UserError } from "./solana.js";

/**
 * RUGR's server: the app's RPC by default, where a new coin's picture and details are kept for pump.fun,
 * and the list of coins launched through RUGR, which is all Trending and New show. Searching and trading
 * work for any token without it.
 */

/**
 * Every launch from RUGR names this address, read-only, so the server can find all of them on-chain, even if
 * the app never got to report one. It's derived from a fixed seed and nobody holds a key for it, so it can
 * only ever be a label. The server checks for the same one.
 */
export const LAUNCH_REFERENCE = new PublicKey("DTd9oBwtsdTK7q2UoN4ejGYe7CuuEyFyaeSk1E2D5RqW");

/** The marker: a transfer of nothing from the creator to themselves, with the reference attached. */
export function launchReferenceInstruction(creator: PublicKey): TransactionInstruction {
  const ix = SystemProgram.transfer({ fromPubkey: creator, toPubkey: creator, lamports: 0 });
  ix.keys.push({ pubkey: LAUNCH_REFERENCE, isSigner: false, isWritable: false });
  return ix;
}

/** A coin launched through RUGR, as the server lists it. */
export interface RugrCoin {
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
  traders?: number;
  holders?: number;
  progressPct?: number;
  graduated?: boolean;
}

export interface MetadataInput {
  image: { path: string; mime: string; name: string };
  name: string;
  symbol: string;
  description: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const LIST_FRESH_MS = 10_000;

export class RugrApi {
  private lists = new Map<string, { at: number; coins: RugrCoin[] }>();

  constructor(
    private baseUrl: string,
    private fetchImpl: FetchLike = fetch,
    private now: () => number = Date.now,
  ) {}

  /** Trending or New. Null if the server can't be reached; the last good list is kept for a short gap. */
  async coins(kind: "trending" | "new"): Promise<RugrCoin[] | null> {
    const hit = this.lists.get(kind);
    if (hit && this.now() - hit.at < LIST_FRESH_MS) return hit.coins;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/coins?kind=${kind}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return hit?.coins ?? null;
      const body = (await res.json()) as { coins?: unknown };
      if (!Array.isArray(body.coins)) return hit?.coins ?? null;
      const coins = (body.coins as RugrCoin[]).filter((c) => typeof c?.mint === "string" && typeof c.symbol === "string");
      this.lists.set(kind, { at: this.now(), coins });
      return coins;
    } catch {
      return hit?.coins ?? null;
    }
  }

  /** Keeps the coin's picture and details on the server, before anything is sent, and returns the link the create puts on-chain. */
  async upload(input: MetadataInput): Promise<string> {
    const image = await fs.promises.readFile(input.image.path);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/launch/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: input.name, symbol: input.symbol, description: input.description, image: image.toString("base64") }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new UserError("RUGR's server can't be reached. Nothing was sent; try again.");
    }
    const body = (await res.json().catch(() => ({}))) as { uri?: unknown; error?: unknown };
    if (!res.ok) throw new UserError(typeof body.error === "string" ? body.error : `RUGR's server answered ${res.status}. Nothing was sent.`);
    if (typeof body.uri !== "string" || !body.uri.startsWith("http") || body.uri.length > 200) {
      throw new UserError("RUGR's server sent back no link for the coin. Nothing was sent.");
    }
    return body.uri;
  }

  /**
   * Tells the server about a launch so it's in New straight away. The server would find it by itself within
   * a minute anyway, so a failure here is only a delay.
   */
  async register(signature: string, tries = 4): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/launch/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signature }),
          signal: AbortSignal.timeout(20_000),
        });
        const body = (await res.json().catch(() => ({}))) as { listed?: boolean; retry?: boolean };
        if (body.listed) {
          this.lists.clear();
          return true;
        }
        if (!body.retry) return false;
      } catch {
        // Try again in a moment.
      }
      await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
    }
    return false;
  }
}

/** The image's type from its name, for the upload. */
export function imageMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
}
