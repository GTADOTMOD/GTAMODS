import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the companion keeps its files. The GTA mod reads `connection.json`
 * from the same folder, so both sides must agree on it:
 *   Windows: %LOCALAPPDATA%\PumpV
 *   other:   ~/.pumpv
 * PUMPV_HOME overrides it (the mod has a matching CompanionDir setting).
 */
export function dataDir(): string {
  const override = process.env.PUMPV_HOME;
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "PumpV");
  }
  return path.join(os.homedir(), ".pumpv");
}

export const files = {
  config: () => path.join(dataDir(), "config.json"),
  keystore: () => path.join(dataDir(), "keystore.json"),
  /** Encrypted wallets taken out of use by Reset wallet. */
  oldWallets: () => path.join(dataDir(), "old-wallets"),
  watchlist: () => path.join(dataDir(), "watchlist.json"),
  history: () => path.join(dataDir(), "history.jsonl"),
  /** Written on every start: { port, token }. Read by the GTA mod. */
  connection: () => path.join(dataDir(), "connection.json"),
  /** What the companion reports while it runs without a window. Never holds secrets. */
  log: () => path.join(dataDir(), "companion.log"),
  /** Token images. Launches may only use files from here. */
  imagesDir: () => path.join(dataDir(), "images"),
};

export function ensureDataDir(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(files.imagesDir(), { recursive: true });
}

/** Writes a file only the current user can read (mode is ignored on Windows,
 * where %LOCALAPPDATA% is already per-user). Atomic via rename. */
export function writePrivateFile(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
