import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A coin launched through RUGR, as verified on-chain. */
export interface Coin {
  mint: string;
  name: string;
  symbol: string;
  /** Its metadata, on this server. */
  uri: string;
  image?: string;
  creator: string;
  createdMs: number;
  signature: string;
}

export interface Metadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  showName: boolean;
  createdOn: string;
}

/**
 * Everything the server keeps, as files: pictures in images/, metadata in meta/, and the list of RUGR coins
 * in coins.json. Pictures and metadata are named by a hash of what's in them, so the same upload twice is
 * the same file, and nothing that's been linked from a coin on-chain ever changes.
 */
export class Store {
  readonly images: string;
  readonly meta: string;
  private coinsFile: string;
  private coins = new Map<string, Coin>();

  constructor(dir: string) {
    this.images = path.join(dir, "images");
    this.meta = path.join(dir, "meta");
    this.coinsFile = path.join(dir, "coins.json");
    fs.mkdirSync(this.images, { recursive: true });
    fs.mkdirSync(this.meta, { recursive: true });
    if (fs.existsSync(this.coinsFile)) {
      for (const c of JSON.parse(fs.readFileSync(this.coinsFile, "utf8")) as Coin[]) this.coins.set(c.mint, c);
    }
  }

  saveImage(bytes: Buffer, ext: string): string {
    const name = `${crypto.createHash("sha256").update(bytes).digest("hex")}.${ext}`;
    const file = path.join(this.images, name);
    if (!fs.existsSync(file)) this.write(file, bytes);
    return name;
  }

  /** The id it's served under. */
  saveMetadata(meta: Metadata): string {
    const text = JSON.stringify(meta);
    const id = crypto.createHash("sha256").update(text).digest("hex").slice(0, 40);
    const file = path.join(this.meta, `${id}.json`);
    if (!fs.existsSync(file)) this.write(file, text);
    return id;
  }

  readMetadata(id: string): Metadata | null {
    if (!/^[0-9a-f]{40}$/.test(id)) return null;
    const file = path.join(this.meta, `${id}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Metadata) : null;
  }

  /** A served file's path, or null if the name isn't one of ours. */
  fileFor(kind: "images" | "meta", name: string): string | null {
    const ok = kind === "images" ? /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/.test(name) : /^[0-9a-f]{40}\.json$/.test(name);
    if (!ok) return null;
    const file = path.join(kind === "images" ? this.images : this.meta, name);
    return fs.existsSync(file) ? file : null;
  }

  hasCoin(mint: string): boolean {
    return this.coins.has(mint);
  }

  allCoins(): Coin[] {
    return [...this.coins.values()];
  }

  addCoin(coin: Coin): void {
    if (this.coins.has(coin.mint)) return;
    this.coins.set(coin.mint, coin);
    this.write(this.coinsFile, JSON.stringify(this.allCoins(), null, 1));
  }

  /**
   * Uploads that never became a coin are deleted after a day, and so are pictures no metadata points to.
   * Anything a coin links to stays for good.
   */
  sweep(now = Date.now(), maxAgeMs = 24 * 60 * 60_000): number {
    const linked = new Set(this.allCoins().map((c) => c.uri.split("/").pop()));
    let removed = 0;
    const keepImages = new Set<string>();
    for (const name of fs.readdirSync(this.meta)) {
      const file = path.join(this.meta, name);
      if (!linked.has(name) && now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.rmSync(file);
        removed++;
        continue;
      }
      const image = (JSON.parse(fs.readFileSync(file, "utf8")) as Metadata).image;
      keepImages.add(image.split("/").pop() ?? "");
    }
    for (const name of fs.readdirSync(this.images)) {
      const file = path.join(this.images, name);
      if (!keepImages.has(name) && now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.rmSync(file);
        removed++;
      }
    }
    return removed;
  }

  /** Written whole and then renamed, so a crash never leaves half a file. */
  private write(file: string, data: string | Buffer): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }
}
