import path from "node:path";
import { PublicKey, SystemProgram } from "@solana/web3.js";

export type Network = "mainnet" | "devnet";

export interface ServerConfig {
  port: number;
  /** Where players reach this server. Coin metadata links point here, and they're on-chain for good. */
  publicUrl: string;
  network: Network;
  /** The private RPC (Helius or similar). Its address holds the key, so it never leaves this server. */
  rpcUrl: string;
  /** Solana's public RPC: the server's own background work, and a fallback when the private one is busy. */
  publicRpcUrl: string;
  /** Coin pictures, metadata and the list of RUGR coins. On Render, a disk mounted here. */
  dataDir: string;
  /** Optional Jupiter API key, for more headroom on token stats. */
  jupiterKey: string;
}

/**
 * Every RUGR launch names this address in its transaction, read-only, so the server can find all of them
 * on-chain, even ones it was never told about. It's derived from a fixed seed and nobody holds a key for it,
 * so it can only ever be a label. The companion uses the same one.
 */
export const LAUNCH_REFERENCE = PublicKey.findProgramAddressSync([Buffer.from("rugr-launch")], SystemProgram.programId)[0];

const PUBLIC_RPC: Record<Network, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const network: Network = env.NETWORK === "devnet" ? "devnet" : "mainnet";
  const port = Number(env.PORT ?? 8080);
  const publicUrl = (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const publicRpcUrl = env.PUBLIC_RPC_URL || PUBLIC_RPC[network];
  return {
    port,
    publicUrl,
    network,
    rpcUrl: env.RPC_URL || publicRpcUrl,
    publicRpcUrl,
    dataDir: env.DATA_DIR || path.join(process.cwd(), "data"),
    jupiterKey: env.JUPITER_API_KEY ?? "",
  };
}
