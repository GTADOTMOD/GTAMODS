import BN from "bn.js";

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function lamportsToSol(lamports: BN | bigint | number): number {
  const s = typeof lamports === "number" ? lamports : BigInt(lamports.toString());
  return Number(s) / LAMPORTS_PER_SOL;
}

/** Converts a SOL amount to lamports without float drift (0.1 -> 100000000). */
export function solToLamports(sol: number): BN {
  if (!Number.isFinite(sol) || sol < 0) throw new Error(`Invalid SOL amount: ${sol}`);
  const [whole, frac = ""] = sol.toFixed(9).split(".");
  return new BN(whole).mul(new BN(LAMPORTS_PER_SOL)).add(new BN(frac.padEnd(9, "0")));
}

export function rawToUi(raw: BN | bigint, decimals: number): number {
  return Number(BigInt(raw.toString())) / 10 ** decimals;
}

/** 1234567 -> "1.23M", 0.5 -> "0.5". */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return trimZeros((n / size).toFixed(abs / size >= 100 ? 0 : 2)) + suffix;
  }
  if (abs >= 1) return trimZeros(n.toFixed(2));
  if (abs === 0) return "0";
  return trimZeros(n.toPrecision(3));
}

/** SOL amounts as a phone row can show them: 1.234, 0.0512, 0.0000321. */
export function fmtSol(sol: number): string {
  if (!Number.isFinite(sol)) return "?";
  const abs = Math.abs(sol);
  if (abs === 0) return "0";
  if (abs >= 1000) return fmtCompact(sol);
  if (abs >= 10) return trimZeros(sol.toFixed(2));
  if (abs >= 1) return trimZeros(sol.toFixed(3));
  if (abs >= 0.001) return trimZeros(sol.toFixed(4));
  // Tiny prices as plain decimals with 3 significant digits (no "e-8").
  const decimals = Math.min(15, Math.ceil(-Math.log10(abs)) + 2);
  return trimZeros(sol.toFixed(decimals));
}

export function fmtUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "?";
  return "$" + (Math.abs(usd) < 1 ? fmtSol(usd) : fmtCompact(usd));
}

/** A wallet's dollars, to the cent: $1,234.50, $0.09, <$0.01. */
export function fmtMoney(usd: number): string {
  if (!Number.isFinite(usd)) return "?";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** +$0.12 or -$0.12, from a change of any size. */
export function fmtMoneyChange(usd: number): string {
  return (usd < 0 ? "-" : "+") + fmtMoney(Math.abs(usd));
}

/** +4.76% or -4.76%. */
export function fmtPercentChange(p: number): string {
  return `${p < 0 ? "-" : "+"}${Math.abs(p).toFixed(2)}%`;
}

export function fmtPercent(p: number): string {
  if (!Number.isFinite(p)) return "?";
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

function trimZeros(s: string): string {
  return s.includes(".") && !s.includes("e") ? s.replace(/\.?0+$/, "") : s;
}

export function shortAddr(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 4)}..${addr.slice(-4)}`;
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Makes text from the internet safe to put on the GTA phone. `~` starts a
 * GTA formatting code (~r~, ~n~, ~INPUT_...~), so a token named "~n~~n~"
 * could otherwise mess with the screen; the game font also has no emoji.
 * Keeps printable ASCII plus Latin-1 letters.
 */
export function phoneText(s: string, max = 40): string {
  const clean = (s ?? "")
    .normalize("NFKC")
    .replace(/~[^~\s]{0,40}~/g, "")
    .replace(/~/g, "")
    .replace(/[^\x20-\x7E¡-ÿ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, Math.max(1, max - 2)) + ".." : clean;
}

/** "$" + ticker, cleaned; falls back to a short address. */
export function ticker(symbol: string | undefined, mint: string): string {
  const t = phoneText(symbol ?? "", 12).replace(/^\$+/, "");
  return t ? `$${t}` : shortAddr(mint);
}
