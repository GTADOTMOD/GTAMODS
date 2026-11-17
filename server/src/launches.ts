import { Connection, PublicKey } from "@solana/web3.js";
import { getPumpProgram } from "@pump-fun/pump-sdk";
import { LAUNCH_REFERENCE } from "./config.js";
import type { Coin, Metadata, Store } from "./store.js";

export class ClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const CREATED_ON = "https://gtamod.onrender.com";

export interface UploadRequest {
  name?: unknown;
  symbol?: unknown;
  description?: unknown;
  /** The picture, base64. */
  image?: unknown;
}

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim() : "");

/** What kind of picture these bytes are, from their first bytes, or null if it isn't one we take. */
export function imageKind(b: Buffer): "png" | "jpg" | "webp" | "gif" | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (b.length > 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) return "gif";
  return null;
}

/**
 * Takes a coin's picture and details, the same checks the phone makes, and keeps them as pump.fun-style
 * metadata. Returns the link the launch puts on-chain.
 */
export function acceptUpload(store: Store, publicUrl: string, req: UploadRequest): { uri: string; image: string } {
  const name = clean(req.name);
  const symbol = clean(req.symbol).replace(/^\$/, "").replace(/\s/g, "").toUpperCase();
  const description = clean(req.description);
  if (name.length < 1 || name.length > 32) throw new ClientError(400, "Name must be 1-32 characters.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new ClientError(400, "Ticker: 1-10 letters or digits.");
  if (description.length > 300) throw new ClientError(400, "Description is too long (max 300).");
  if (typeof req.image !== "string" || req.image.length === 0) throw new ClientError(400, "A coin needs a picture.");
  const bytes = Buffer.from(req.image, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ClientError(413, "That picture is too big (max 4 MB).");
  const kind = imageKind(bytes);
  if (!kind) throw new ClientError(415, "The picture must be a PNG, JPEG, WebP or GIF.");
  const image = `${publicUrl}/i/${store.saveImage(bytes, kind)}`;
  const meta: Metadata = { name, symbol, description, image, showName: true, createdOn: CREATED_ON };
  return { uri: `${publicUrl}/m/${store.saveMetadata(meta)}.json`, image };
}

/** A pump.fun create, as read from a confirmed transaction's logs. */
export interface Created {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  createdMs: number;
  mayhem: boolean;
  /** Whether the transaction names LAUNCH_REFERENCE, which only RUGR's launches do. */
  fromRugr: boolean;
}

const EVENT_PREFIX = "Program data: ";

interface JsonTransaction {
  meta?: { err?: unknown; logMessages?: string[] | null; loadedAddresses?: { writable?: string[]; readonly?: string[] } } | null;
  transaction?: { message?: { accountKeys?: (string | { pubkey: string })[] } };
}

/**
 * A transaction as plain JSON. The chain now carries newer transaction versions than this Solana library
 * can decode, and plain JSON reads any of them; all this needs is the logs and the accounts.
 */
async function getTransactionJson(endpoint: string, signature: string, fetchImpl: typeof fetch): Promise<JsonTransaction | null> {
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RPC answered ${res.status}`);
  const body = (await res.json()) as { result?: JsonTransaction | null; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result ?? null;
}

/** The create in a transaction, or why there isn't one. */
export async function readLaunch(connection: Connection, signature: string, fetchImpl: typeof fetch = fetch): Promise<Created | string> {
  const tx = await getTransactionJson(connection.rpcEndpoint, signature, fetchImpl);
  if (!tx) return "not confirmed yet";
  if (tx.meta?.err) return "the transaction failed";
  const keys = [
    ...(tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey)),
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const fromRugr = keys.includes(LAUNCH_REFERENCE.toBase58());
  const created = createIn(connection, tx.meta?.logMessages ?? []);
  if (!created) return "no pump.fun create in it";
  return { ...created, fromRugr };
}

/** Decodes the CreateEvent pump.fun logs, the same way the companion reads its live feed. */
export function createIn(connection: Connection, logs: string[]): Omit<Created, "fromRugr"> | null {
  const events = getPumpProgram(connection).coder.events as unknown as { decode(log: string): { name: string; data: Record<string, any> } | null };
  for (const line of logs) {
    if (!line.startsWith(EVENT_PREFIX)) continue;
    let event: { name: string; data: Record<string, any> } | null = null;
    try {
      event = events.decode(line.slice(EVENT_PREFIX.length));
    } catch {
      continue;
    }
    if (!event || event.name.toLowerCase() !== "createevent") continue;
    const e = event.data;
    const key = (v: unknown) => (v instanceof PublicKey ? v.toBase58() : String(v));
    return {
      mint: key(e.mint),
      name: String(e.name),
      symbol: String(e.symbol),
      uri: String(e.uri),
      creator: key(e.creator ?? e.user),
      createdMs: Number(String(e.timestamp)) * 1000,
      mayhem: Boolean(e.isMayhemMode),
    };
  }
  return null;
}

/**
 * Lists a launch if it's really RUGR's: it names the reference, it isn't a Mayhem coin, and its metadata is
 * one this server issued. Returns why not, otherwise.
 */
export function listIfRugr(store: Store, publicUrl: string, created: Created, signature: string): Coin | string {
  if (store.hasCoin(created.mint)) return store.allCoins().find((c) => c.mint === created.mint)!;
  if (!created.fromRugr) return "not launched from RUGR";
  if (created.mayhem) return "a Mayhem coin";
  const prefix = `${publicUrl}/m/`;
  if (!created.uri.startsWith(prefix)) return "its metadata isn't RUGR's";
  const meta = store.readMetadata(created.uri.slice(prefix.length).replace(/\.json$/, ""));
  if (!meta) return "its metadata isn't RUGR's";
  const coin: Coin = {
    mint: created.mint,
    name: created.name,
    symbol: created.symbol,
    uri: created.uri,
    image: meta.image,
    creator: created.creator,
    createdMs: created.createdMs,
    signature,
  };
  store.addCoin(coin);
  return coin;
}

/**
 * Finds every RUGR launch by the reference address, including any the app never reported, so the list can
 * always be rebuilt from the chain. Each pass reads only what's new since the last one.
 */
export class LaunchScanner {
  private newest: string | undefined;
  /** Signatures still to read, and how many more tries each gets: a transaction can be listed a moment before it can be read. */
  private pending = new Map<string, number>();

  constructor(
    private connection: Connection,
    private store: Store,
    private publicUrl: string,
    private log: (m: string) => void = () => undefined,
  ) {}

  async scan(): Promise<number> {
    const known = new Set(this.store.allCoins().map((c) => c.signature));
    let top: string | undefined;
    let before: string | undefined;
    const fresh: string[] = [];
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(LAUNCH_REFERENCE, { until: this.newest, before, limit: 1000 }, "confirmed");
      top ??= page[0]?.signature;
      for (const s of page) if (!s.err && !known.has(s.signature)) fresh.push(s.signature);
      if (page.length < 1000) break;
      before = page.at(-1)!.signature;
    }
    // Only once the whole walk has worked, so a failed one is simply done again next time.
    if (top) this.newest = top;
    for (const s of fresh) if (!this.pending.has(s)) this.pending.set(s, 5);

    let added = 0;
    for (const [signature, triesLeft] of [...this.pending]) {
      const created = await readLaunch(this.connection, signature);
      if (created === "not confirmed yet" && triesLeft > 1) {
        this.pending.set(signature, triesLeft - 1);
        continue;
      }
      this.pending.delete(signature);
      if (typeof created === "string") continue;
      const listed = listIfRugr(this.store, this.publicUrl, created, signature);
      if (typeof listed === "string") this.log(`skipped ${signature.slice(0, 8)}: ${listed}`);
      else added++;
    }
    return added;
  }
}
