#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { readClipboard } from "../src/clipboard.js";
import { WalletGate, WalletStore } from "../src/gate.js";
import { Jupiter } from "../src/jupiter.js";
import { TokenDirectory } from "../src/tokens.js";
import { KeystoreFile, encryptKeypair } from "../src/keystore.js";
import { MetaResolver } from "../src/metadata.js";
import { files } from "../src/paths.js";
import { SolPrice } from "../src/price.js";
import { PumpEngine } from "../src/pump.js";
import { RugrApi, RugrCoin } from "../src/rugr.js";
import { History, Watchlist } from "../src/store.js";
import { PhoneApp, UiHandler } from "../src/ui.js";
import { FakeConnection, fakeJupiterFetch, fakeRugrFetch, fakeTokensFetch, seedChain, seedSolPrice } from "../test/fakeChain.js";

/*
 * The phone app in a browser, for using every screen without GTA V. The page
 * follows the same navigation rules as mod/src/PumpVScript.cs and talks to the
 * real PhoneApp, so what it shows is what the phone would be sent.
 *
 *   npm run sim                  Live data, throwaway empty wallet, always practice
 *   npm run sim -- --fake        No network: a fake chain where every flow completes
 *   npm run sim -- --fake --first-run   The same, starting from "Create wallet"
 *   npm run sim -- --fake --locked      The same, starting from "Unlock wallet"
 *   npm run sim -- --attach      Your running companion and your real wallet
 *
 * It listens on 127.0.0.1 only and refuses other sites' pages, the same way
 * the companion's own API does.
 */

interface Backend {
  label: string;
  note: string;
  imagesDir: string;
  call(method: string, p: string, body: Record<string, unknown>): Promise<unknown>;
}

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_PORT = 47616;
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const SIM_PASSWORD = "simulator-password";

function appBackend(app: UiHandler, imagesDir: string, label: string, note: string): Backend {
  return {
    label,
    note,
    imagesDir,
    call: async (method, p, body) =>
      (await app.handle(method, new URL(p, "http://127.0.0.1"), body)) ?? {
        nav: "none",
        toast: { text: `No such screen: ${p}`, level: "error" },
      },
  };
}

/** Keeps the simulator's wallet in memory, so it never touches a real keystore. */
function memoryStore(): WalletStore {
  let file: KeystoreFile | null = null;
  return {
    exists: () => file !== null,
    read: () => file!,
    save: (f) => {
      file = f;
    },
    remove: () => {
      file = null;
    },
  };
}

/** A throwaway folder, so the simulator never touches real history or watchlists. */
function scratchFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpv-sim-"));
  const imagesDir = path.join(dir, "images");
  fs.mkdirSync(imagesDir);
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    imagesDir,
    history: new History(path.join(dir, "history.jsonl")),
    watchlist: new Watchlist(path.join(dir, "watchlist.json")),
  };
}

function liveBackend(rpcUrl: string | undefined): Backend {
  const saved = fs.existsSync(files.config()) ? loadConfig() : DEFAULT_CONFIG;
  const config = { ...saved, dryRun: true, rpcUrl: rpcUrl ?? saved.rpcUrl };
  const connection = new Connection(config.rpcUrl, { commitment: "confirmed" });
  const scratch = scratchFiles();
  const api = new RugrApi(config.apiUrl);
  const meta = new MetaResolver(connection);
  const price = new SolPrice(connection);
  const engine = new PumpEngine(connection, config.slippagePercent);
  const gate = new WalletGate({
    config,
    saveConfig: () => {},
    copy: async () => {},
    paste: readClipboard,
    connection,
    engine,
    meta,
    history: scratch.history,
    store: memoryStore(),
    makeApp: (wallet) =>
      new PhoneApp({
        config,
        connection,
        wallet,
        engine,
        api,
        meta,
        price,
        ...scratch,
        paste: readClipboard,
        log: (m) => console.error(m),
      }),
  }).openWith(Keypair.generate());
  return appBackend(
    gate,
    scratch.imagesDir,
    "Live data, empty wallet",
    `Real coins from ${new URL(config.rpcUrl).hostname}. The wallet is brand new with 0 SOL, so buys stop at "Not enough SOL". Nothing can be sent.`,
  );
}

const FAKE_COINS = [
  ["Alpha Test", "ALPHA"],
  ["Beta Test", "BETA"],
  ["Gamma Test", "GAMMA"],
  ["Delta Test", "DELTA"],
  ["Epsilon Test", "EPSLN"],
];

async function fakeBackend(start: "open" | "first-run" | "locked"): Promise<Backend> {
  const fc = new FakeConnection();
  const wallet = Keypair.generate();
  const connection = fc.asConnection();
  const config = { ...DEFAULT_CONFIG, dryRun: true };
  const coins: RugrCoin[] = [];
  const api = new RugrApi("https://rugr.test", fakeRugrFetch(() => coins));
  const scratch = scratchFiles();
  const store = memoryStore();
  if (start === "locked") store.save(encryptKeypair(wallet, SIM_PASSWORD));
  const engine = new PumpEngine(connection, config.slippagePercent);
  const meta = new MetaResolver(connection);
  const mints: PublicKey[] = [];
  // Pasting gives the first fake coin, so the swap screens work with no clipboard.
  const paste = async () => mints[0].toBase58();
  const gate = new WalletGate({
    config,
    saveConfig: () => {},
    copy: async () => {},
    paste,
    connection,
    engine,
    meta,
    history: scratch.history,
    store,
    newKeypair: () => wallet, // the one seeded with coins below
    makeApp: (w) =>
      new PhoneApp({
        config,
        connection,
        wallet: w,
        engine,
        api,
        meta,
        price: new SolPrice(connection),
        history: scratch.history,
        watchlist: scratch.watchlist,
        imagesDir: scratch.imagesDir,
        jupiter: new Jupiter(fakeJupiterFetch(wallet.publicKey)),
        tokens: new TokenDirectory(fakeTokensFetch()),
        paste,
      }),
  });
  if (start === "open") gate.openWith(wallet);

  seedSolPrice(fc, 95.82);
  // Made-up RUGR coins, as the server would list them: busiest first.
  for (const [i, [name, symbol]] of FAKE_COINS.entries()) {
    const { mint } = await seedChain(fc, wallet.publicKey, { holdTokens: i === 0 ? BigInt("25000000000000") : undefined });
    mints.push(mint);
    coins.push({
      mint: mint.toBase58(),
      name,
      symbol,
      createdMs: Date.now() - 40_000 * (FAKE_COINS.length - i),
      marketCapSol: 30 + i,
      changePct: 12.5 - i * 6,
      traders: 8 - i,
      progressPct: 31,
    });
  }

  return appBackend(
    gate,
    scratch.imagesDir,
    "Fake chain, no network",
    "Made-up coins and a wallet holding 2 SOL. Every buy, sell and launch completes as a simulation." +
      (start === "locked" ? ` The password is ${SIM_PASSWORD}.` : ""),
  );
}

function attachBackend(): Backend {
  const file = files.connection();
  if (!fs.existsSync(file)) throw new Error(`No companion is running (${file} not found). Start one with: pumpv start`);
  const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as { port: number; token: string; imagesDir: string };
  return {
    label: "Attached to your companion",
    note: 'This is your REAL wallet. If the buttons say "CONFIRM" rather than "SIMULATE", trades are sent for real.',
    imagesDir: read().imagesDir,
    call: async (method, p, body) => {
      const { port, token } = read(); // A restarted companion gets a new port and token.
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { "X-PumpV-Token": token, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`Companion error ${res.status}`);
      return res.json();
    },
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function createSimServer(backend: Backend, port: number): http.Server {
  const page = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "phone-sim.html"));
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return http.createServer(async (req, res) => {
    try {
      if (!hosts.has(String(req.headers.host ?? ""))) return send(res, 403, { error: "bad host" });
      const origin = req.headers.origin;
      if (origin !== undefined && !hosts.has(origin.replace(/^http:\/\//, ""))) return send(res, 403, { error: "other sites not allowed" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          // The only outside content: the font, and coin images from pump.fun's public image server.
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
            "font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'",
        });
        return res.end(page);
      }
      if (req.method === "GET" && url.pathname === "/sim/info") return send(res, 200, { label: backend.label, note: backend.note });
      if (req.method === "GET" && url.pathname.startsWith("/art/")) {
        const name = url.pathname.slice("/art/".length);
        const file = path.join(__dirname, "..", "..", "tools", "art", name);
        if (!/^[a-z-]+\.(png|jpg)$/.test(name) || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": name.endsWith(".png") ? "image/png" : "image/jpeg", "Cache-Control": "max-age=3600" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "GET" && url.pathname.startsWith("/sim/image/")) {
        const name = decodeURIComponent(url.pathname.slice("/sim/image/".length));
        const file = path.join(backend.imagesDir, name);
        if (!/^[\w.-]+\.png$/.test(name) || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "json only" });

      const body = await readBody(req);
      if (url.pathname === "/sim/photo") {
        const name = `sim-photo-${Date.now()}.png`;
        fs.writeFileSync(path.join(backend.imagesDir, name), TEST_PNG);
        return send(res, 200, { name });
      }
      if (url.pathname === "/sim/call") {
        const { method, path: p, body: callBody } = body as { method?: string; path?: string; body?: Record<string, unknown> };
        if ((method !== "GET" && method !== "POST") || typeof p !== "string" || !p.startsWith("/ui/")) {
          return send(res, 400, { error: "bad call" });
        }
        return send(res, 200, await backend.call(method, p, callBody ?? {}));
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 502, { error: (e as Error).message });
    }
  });
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const port = Number(option(args, "--port") ?? DEFAULT_PORT);
  const backend = args.includes("--fake")
    ? await fakeBackend(args.includes("--first-run") ? "first-run" : args.includes("--locked") ? "locked" : "open")
    : args.includes("--attach")
      ? attachBackend()
      : liveBackend(option(args, "--rpc"));
  const server = createSimServer(backend, port);
  server.once("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use. Is the simulator already running?` : e.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`\nPumpV phone simulator: http://127.0.0.1:${port}`);
    console.log(`Mode: ${backend.label}`);
    console.log(`${backend.note}\n\nOpen that address in your browser. Ctrl+C to stop.\n`);
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
