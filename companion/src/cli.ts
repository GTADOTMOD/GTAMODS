#!/usr/bin/env node
import fs from "node:fs";
import bs58 from "bs58";
import { Connection, Keypair } from "@solana/web3.js";
import { copyToClipboard, readClipboard } from "./clipboard.js";
import { ConfigError, loadConfig, saveConfig } from "./config.js";
import { WalletGate } from "./gate.js";
import {
  MIN_PASSWORD_LENGTH,
  WrongPasswordError,
  decryptKeypair,
  encryptKeypair,
  keystoreExists,
  parseSecretKey,
  readKeystore,
  saveKeystore,
} from "./keystore.js";
import { MetaResolver } from "./metadata.js";
import { watchParent } from "./parent.js";
import { dataDir, ensureDataDir, files, writePrivateFile } from "./paths.js";
import { SolPrice } from "./price.js";
import { prompt, promptHidden } from "./prompt.js";
import { PumpEngine } from "./pump.js";
import { RugrApi } from "./rugr.js";
import { createServer, newApiToken } from "./server.js";
import { History, Watchlist } from "./store.js";
import { PhoneApp } from "./ui.js";

const HELP = `RUGR companion - the wallet + Solana side of the RUGR GTA V phone app.

Usage:
  pumpv start            Serve the phone app on 127.0.0.1. The wallet is created or unlocked
                         on the phone. The mod runs this for you, with --parent-pid set to
                         the game's, so it stops along with the game.
  pumpv wallet new       Create a wallet here instead of on the phone
  pumpv wallet import    Import an existing secret key
  pumpv wallet show      Print the wallet address
  pumpv wallet export    Print the secret key (to move funds back to Phantom etc.)
  pumpv config           Show where config.json lives and what it contains
  pumpv check            Test the RPC, the live coin feed and the image host (no wallet needed)

Files live in ${dataDir()}
`;

async function newPassword(): Promise<string> {
  for (;;) {
    const a = await promptHidden(`New password (min ${MIN_PASSWORD_LENGTH} chars): `);
    if (a.length < MIN_PASSWORD_LENGTH) {
      console.log("Too short.");
      continue;
    }
    const b = await promptHidden("Repeat password: ");
    if (a === b) return a;
    console.log("Passwords do not match, try again.");
  }
}

async function unlock(): Promise<Keypair> {
  const ks = readKeystore();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pw = await promptHidden(`Password for wallet ${ks.address}: `);
    try {
      return decryptKeypair(ks, pw);
    } catch (e) {
      if (!(e instanceof WrongPasswordError) || attempt === 3) throw e;
      console.log("Wrong password.");
    }
  }
  throw new WrongPasswordError();
}

function refuseOverwrite(): boolean {
  if (!keystoreExists()) return false;
  console.error(`A wallet already exists at ${files.keystore()}.`);
  console.error("Move that file somewhere safe first if you really want a different wallet.");
  process.exitCode = 1;
  return true;
}

async function save(keypair: Keypair): Promise<void> {
  const password = await newPassword();
  console.log("Encrypting (takes a second)...");
  saveKeystore(encryptKeypair(keypair, password));
  console.log(`\nWallet saved: ${files.keystore()}`);
  console.log(`Address:      ${keypair.publicKey.toBase58()}`);
  console.log("\nSend a small amount of SOL to that address to start trading.");
  console.log("There is no password reset: if you forget it, the funds are gone.");
  console.log("Back up the secret with `pumpv wallet export` and keep it offline.");
}

async function walletCommand(sub: string | undefined): Promise<void> {
  ensureDataDir();
  switch (sub) {
    case "new":
      if (refuseOverwrite()) return;
      await save(Keypair.generate());
      return;
    case "import": {
      if (refuseOverwrite()) return;
      const secret = await promptHidden("Paste the secret key (base58 or JSON array; hidden): ");
      const keypair = parseSecretKey(secret);
      console.log(`Importing ${keypair.publicKey.toBase58()}`);
      await save(keypair);
      return;
    }
    case "show":
      if (!keystoreExists()) throw new Error("No wallet yet. Run `pumpv wallet new`.");
      console.log(readKeystore().address);
      return;
    case "export": {
      if (!keystoreExists()) throw new Error("No wallet yet.");
      const ok = await prompt("This prints your secret key on screen. Anyone who sees it can take your funds. Type EXPORT to continue: ");
      if (ok.trim() !== "EXPORT") return;
      const kp = await unlock();
      console.log(`\n${bs58.encode(kp.secretKey)}\n`);
      return;
    }
    default:
      console.log(HELP);
  }
}

function parentPid(args: string[]): number | null {
  const i = args.indexOf("--parent-pid");
  if (i < 0) return null;
  const pid = Number(args[i + 1]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("--parent-pid needs a process id.");
  return pid;
}

function writeLog(line: string): void {
  try {
    fs.appendFileSync(files.log(), line + "\n", { mode: 0o600 });
  } catch {
    // Only a log; nothing to tell anyone about.
  }
}

async function start(args: string[]): Promise<void> {
  ensureDataDir();
  const parent = parentPid(args);
  const config = loadConfig();
  fs.writeFileSync(files.log(), "", { mode: 0o600 });
  const log = (m: string) => {
    const line = `[${new Date().toISOString()}] ${m}`;
    console.error(line);
    writeLog(line);
  };

  const connection = new Connection(config.rpcUrl, { commitment: "confirmed" });
  const engine = new PumpEngine(connection, config.slippagePercent);
  const api = new RugrApi(config.apiUrl);
  const meta = new MetaResolver(connection);
  const price = new SolPrice(connection);
  const history = new History(files.history());
  const app = new WalletGate({
    config,
    saveConfig,
    copy: copyToClipboard,
    paste: readClipboard,
    connection,
    engine,
    meta,
    history,
    log,
    makeApp: (wallet) =>
      new PhoneApp({
        config,
        connection,
        wallet,
        engine,
        api,
        meta,
        price,
        history,
        watchlist: new Watchlist(files.watchlist()),
        imagesDir: files.imagesDir(),
        paste: readClipboard,
        log,
      }),
  });

  const token = newApiToken();
  const server = createServer(app, { token, port: config.port, log });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "EADDRINUSE" ? new Error(`Port ${config.port} is in use. Is the companion already running?`) : e),
    );
    server.listen(config.port, "127.0.0.1", () => resolve());
  });
  writePrivateFile(
    files.connection(),
    JSON.stringify({ port: config.port, token, imagesDir: files.imagesDir(), pid: process.pid }, null, 2) + "\n",
  );

  console.log(`\nRUGR companion running on 127.0.0.1:${config.port}`);
  console.log(`Wallet:  ${keystoreExists() ? "unlock it on the phone" : "create it on the phone"}`);
  console.log(`Mode:    ${config.dryRun ? "Practice (simulate only; change it on the phone)" : "Real money - real transactions"}`);
  console.log(`Images:  ${files.imagesDir()}`);
  console.log(parent === null ? "\nLeave this window open while you play. Ctrl+C to stop.\n" : `\nStops when process ${parent} exits.\n`);

  const stop = () => {
    try {
      fs.rmSync(files.connection(), { force: true });
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (parent !== null) watchParent(parent, stop);
  process.on("uncaughtException", (e) => {
    log(`crashed: ${e.stack ?? String(e)}`);
    stop();
  });
}

/** Checks what a launch or a list would need, without a wallet or any SOL. */
async function check(): Promise<void> {
  ensureDataDir();
  const config = loadConfig();
  const connection = new Connection(config.rpcUrl, { commitment: "confirmed" });

  try {
    console.log(`RPC:         OK, slot ${await connection.getSlot()}`);
  } catch (e) {
    console.log(`RPC:         FAILED, ${(e as Error).message}`);
  }

  const health = await fetch(`${config.apiUrl}/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const body = (await health?.json().catch(() => null)) as { coins?: number } | null;
  console.log(health?.ok ? `RUGR server: OK, ${body?.coins ?? 0} coins launched on RUGR` : `RUGR server: FAILED, ${config.apiUrl} answered ${health?.status ?? "nothing"}`);
  const trending = await new RugrApi(config.apiUrl).coins("trending");
  console.log(trending === null ? "Trending:    FAILED" : `Trending:    OK, ${trending.length} coins`);
  process.exit(0);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, sub] = argv;
  switch (cmd) {
    case "wallet":
      return walletCommand(sub);
    case "start":
      return start(argv.slice(1));
    case "config": {
      ensureDataDir();
      const config = loadConfig();
      console.log(files.config());
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "check":
      return check();
    default:
      console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((e) => {
  const message = e instanceof ConfigError ? `Config error: ${e.message}` : String((e as Error).message ?? e);
  console.error(message);
  writeLog(message); // With no window, this is the only place it can be read.
  process.exit(1);
});
