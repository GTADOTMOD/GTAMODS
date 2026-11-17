import crypto from "node:crypto";
import fs from "node:fs";
import { writePrivateFile } from "./paths.js";

/** Pending confirm screens. Each id works once and only until it expires,
 * so a double-press or a stale screen can never send a second trade. */
export class QuoteStore<T> {
  private items = new Map<string, { value: T; expires: number }>();

  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  put(value: T): string {
    this.sweep();
    const id = crypto.randomBytes(12).toString("base64url");
    this.items.set(id, { value, expires: this.now() + this.ttlMs });
    return id;
  }

  /** Removes and returns the quote, or undefined if unknown or expired. */
  take(id: string): T | undefined {
    const hit = this.items.get(id);
    this.items.delete(id);
    if (!hit || hit.expires < this.now()) return undefined;
    return hit.value;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, v] of this.items) if (v.expires < t) this.items.delete(id);
  }
}

export interface HistoryEntry {
  ts: number;
  kind: "buy" | "sell" | "launch" | "swap" | "send";
  mint: string;
  symbol?: string;
  sol: number;
  tokens: number;
  signature?: string;
  simulated: boolean;
}

export class History {
  constructor(private file: string) {}

  append(e: HistoryEntry): void {
    fs.appendFileSync(this.file, JSON.stringify(e) + "\n", { mode: 0o600 });
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }

  recent(n: number): HistoryEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
    const out: HistoryEntry[] = [];
    for (const line of lines.slice(-n).reverse()) {
      try {
        out.push(JSON.parse(line) as HistoryEntry);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }
}

export class Watchlist {
  private mints: string[] = [];

  constructor(private file: string) {
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(raw)) this.mints = raw.filter((m) => typeof m === "string").slice(0, 50);
      } catch {
        this.mints = [];
      }
    }
  }

  list(): string[] {
    return [...this.mints];
  }

  has(mint: string): boolean {
    return this.mints.includes(mint);
  }

  set(mint: string, on: boolean): void {
    this.mints = this.mints.filter((m) => m !== mint);
    if (on) this.mints.unshift(mint);
    this.mints = this.mints.slice(0, 50);
    writePrivateFile(this.file, JSON.stringify(this.mints, null, 2) + "\n");
  }
}
