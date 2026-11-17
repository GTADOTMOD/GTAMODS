import fs from "node:fs";
import { files, writePrivateFile } from "./paths.js";

/** RUGR's server: Trending and New, launches, and the app's RPC unless a player sets their own. */
export const DEFAULT_API_URL = "https://rugr-api.onrender.com";
/** What the RPC used to default to, before RUGR had its own; configs that still have it move to the server's. */
const OLD_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export interface Config {
  /** RUGR's server. */
  apiUrl: string;
  /** Solana RPC endpoint. By default RUGR's own, through its server; a player can set any other here. */
  rpcUrl: string;
  /** Local port for the GTA mod. Only 127.0.0.1 is ever bound. */
  port: number;
  /** When true, trades and launches are simulated on-chain but never sent. */
  dryRun: boolean;
  /** Slippage tolerance in percent (10 = 10%). */
  slippagePercent: number;
  /** Hard cap on SOL spent by a single buy. */
  maxSolPerTrade: number;
  /** Hard cap on the first buy of a token launch. */
  maxLaunchBuySol: number;
  buyPresetsSol: number[];
  sellPresetsPercent: number[];
  launchBuyPresetsSol: number[];
  /** Priority fee, in micro-lamports per compute unit. */
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  launchComputeUnitLimit: number;
  /** How long a confirm screen stays valid. */
  quoteTtlSeconds: number;
}

export const DEFAULT_CONFIG: Config = {
  apiUrl: DEFAULT_API_URL,
  rpcUrl: `${DEFAULT_API_URL}/rpc`,
  port: 47615,
  dryRun: true,
  slippagePercent: 10,
  maxSolPerTrade: 0.5,
  maxLaunchBuySol: 1,
  buyPresetsSol: [0.01, 0.05, 0.1, 0.25],
  sellPresetsPercent: [25, 50, 100],
  launchBuyPresetsSol: [0, 0.01, 0.05, 0.1, 0.25],
  priorityFeeMicroLamports: 200_000,
  computeUnitLimit: 250_000,
  launchComputeUnitLimit: 400_000,
  quoteTtlSeconds: 30,
};

export class ConfigError extends Error {}

function isPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Merges a user config over the defaults and rejects values that could
 * make a trade do something the user did not intend. */
export function validateConfig(raw: unknown): Config {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    throw new ConfigError("config.json must contain a JSON object");
  }
  const user = { ...((raw ?? {}) as Partial<Config> & Record<string, unknown>) };
  // Launches used to upload through pump.fun or Pinata; RUGR's server does it now.
  delete user.ipfsUploadUrl;
  delete user.pinataJwt;
  if (user.rpcUrl === OLD_DEFAULT_RPC) delete user.rpcUrl;
  const c: Config = { ...DEFAULT_CONFIG, ...user };
  if (user.rpcUrl === undefined) c.rpcUrl = `${c.apiUrl.replace(/\/+$/, "")}/rpc`;

  for (const key of ["apiUrl", "rpcUrl"] as const) {
    let url: URL;
    try {
      url = new URL(c[key]);
    } catch {
      throw new ConfigError(`${key} is not a valid URL: ${c[key]}`);
    }
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new ConfigError(`${key} must use https:// (http only for localhost)`);
    }
  }
  c.apiUrl = c.apiUrl.replace(/\/+$/, "");
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) {
    throw new ConfigError("port must be an integer between 1024 and 65535");
  }
  if (typeof c.dryRun !== "boolean") throw new ConfigError("dryRun must be true or false");
  if (!isPositive(c.slippagePercent) || c.slippagePercent > 50) {
    throw new ConfigError("slippagePercent must be > 0 and <= 50");
  }
  for (const key of ["maxSolPerTrade", "maxLaunchBuySol"] as const) {
    if (!isPositive(c[key])) throw new ConfigError(`${key} must be a positive number`);
  }
  const presets = (key: keyof Config, allowZero: boolean, max: number) => {
    const v = c[key];
    if (!Array.isArray(v) || v.length === 0 || v.length > 8) {
      throw new ConfigError(`${key} must be a list of 1-8 numbers`);
    }
    for (const n of v) {
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > max) {
        throw new ConfigError(`${key} contains ${String(n)}; allowed: ${allowZero ? "0" : ">0"} to ${max}`);
      }
    }
  };
  presets("buyPresetsSol", false, c.maxSolPerTrade);
  presets("sellPresetsPercent", false, 100);
  presets("launchBuyPresetsSol", true, c.maxLaunchBuySol);
  for (const key of ["priorityFeeMicroLamports", "computeUnitLimit", "launchComputeUnitLimit", "quoteTtlSeconds"] as const) {
    if (!Number.isInteger(c[key]) || c[key] < 0) {
      throw new ConfigError(`${key} must be a non-negative integer`);
    }
  }
  if (c.computeUnitLimit < 50_000 || c.launchComputeUnitLimit < 100_000) {
    throw new ConfigError("compute unit limits are too low for pump.fun transactions");
  }
  if (c.computeUnitLimit > 1_400_000 || c.launchComputeUnitLimit > 1_400_000) {
    throw new ConfigError("compute unit limits cannot exceed 1,400,000");
  }
  // Priority fee ceiling: 5 SOL-per-trade-mistakes are easy to make by
  // adding a zero. 50M micro-lamports * 400k CU = 0.02 SOL.
  if (c.priorityFeeMicroLamports > 50_000_000) {
    throw new ConfigError("priorityFeeMicroLamports is unreasonably high (max 50,000,000)");
  }
  if (c.quoteTtlSeconds < 5 || c.quoteTtlSeconds > 120) {
    throw new ConfigError("quoteTtlSeconds must be between 5 and 120");
  }
  return c;
}

export function saveConfig(config: Config): void {
  writePrivateFile(files.config(), JSON.stringify(config, null, 2) + "\n");
}

export function loadConfig(): Config {
  const file = files.config();
  if (!fs.existsSync(file)) {
    writePrivateFile(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return { ...DEFAULT_CONFIG };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return validateConfig(raw);
}
