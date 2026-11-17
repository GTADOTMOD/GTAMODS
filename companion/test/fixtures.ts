/**
 * Writes real companion responses (rendered against the fake chain) as JSON
 * files, for the C# tests in mod/tests/ to read:
 *   node dist/test/fixtures.js <outDir>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { WalletGate, WalletStore } from "../src/gate.js";
import { Jupiter } from "../src/jupiter.js";
import { KeystoreFile } from "../src/keystore.js";
import { MetaResolver } from "../src/metadata.js";
import { SolPrice } from "../src/price.js";
import { PumpEngine } from "../src/pump.js";
import { RugrApi, RugrCoin } from "../src/rugr.js";
import { History, Watchlist } from "../src/store.js";
import { TokenDirectory, USDC_MINT } from "../src/tokens.js";
import { PhoneApp, UiResponse } from "../src/ui.js";
import { FakeConnection, fakeJupiterFetch, fakeRugrFetch, fakeTokensFetch, seedChain, seedSolPrice } from "./fakeChain.js";

async function main(outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pumpv-fixtures-"));
  const fc = new FakeConnection();
  const wallet = Keypair.generate();
  const { mint } = await seedChain(fc, wallet.publicKey, { holdTokens: BigInt("25000000000000") });
  const connection = fc.asConnection();
  const listed: RugrCoin[] = [];
  const deps = {
    config: DEFAULT_CONFIG,
    connection,
    wallet,
    engine: new PumpEngine(connection, DEFAULT_CONFIG.slippagePercent),
    api: new RugrApi("https://rugr.test", fakeRugrFetch(() => listed)),
    meta: new MetaResolver(connection),
    price: new SolPrice(connection),
    history: new History(path.join(tmp, "history.jsonl")),
    watchlist: new Watchlist(path.join(tmp, "watchlist.json")),
    imagesDir: tmp,
    jupiter: new Jupiter(fakeJupiterFetch(wallet.publicKey, { outAmount: "9582000" })),
  };
  const app = new PhoneApp({ ...deps, tokens: new TokenDirectory(fakeTokensFetch()) });
  const offline = new PhoneApp({
    ...deps,
    api: new RugrApi("https://rugr.test", fakeRugrFetch(() => [], { down: true })),
    price: new SolPrice(connection),
    tokens: new TokenDirectory(fakeTokensFetch()),
  });
  const m = mint.toBase58();
  const call = async (method: string, p: string, body: Record<string, unknown> = {}) =>
    (await app.handle(method, new URL(p, "http://127.0.0.1"), body)) as UiResponse;

  const out: Record<string, UiResponse> = {
    listOffline: (await offline.handle("GET", new URL("/ui/list?kind=new", "http://127.0.0.1"), {})) as UiResponse,
  };
  seedSolPrice(fc, 95.82);
  out.home = await call("GET", "/ui/home");
  out.token = await call("GET", `/ui/token?mint=${m}`);
  out.launch = await call("GET", "/ui/launch");
  out.error = await call("GET", `/ui/token?mint=${Keypair.generate().publicKey.toBase58()}`);
  out.wallet = await call("GET", "/ui/wallet");
  out.confirm = await call("POST", "/ui/quote/buy", { mint: m, sol: 0.1 });
  const exec = out.confirm.screen!.rows.find((r) => r.action?.kind === "post")!;
  out.result = await call("POST", "/ui/execute", (exec.action as { body: Record<string, unknown> }).body);
  out.sellConfirm = await call("POST", "/ui/quote/sell", { mint: m, percent: 50 });

  // Lists with coins in them, for the layout previews: RUGR coins as the server lists them. The empty list comes
  // from an app of its own, since each app keeps its lists for a few seconds.
  const empty = new PhoneApp({ ...deps, api: new RugrApi("https://rugr.test", fakeRugrFetch(() => [])), tokens: new TokenDirectory(fakeTokensFetch()) });
  out.listEmpty = (await empty.handle("GET", new URL("/ui/list?kind=trending", "http://127.0.0.1"), {})) as UiResponse;
  const coins = [
    ["Los Santos Dog", "LSDOG"],
    ["Vinewood Whale", "WHALE"],
    ["Chiliad Cat", "CATT"],
    ["A Very Long Coin Name Indeed", "LONGTICKER"],
    ["Bank Run", "RUN"],
  ];
  for (const [i, [name, symbol]] of coins.entries()) {
    listed.push({
      mint: Keypair.generate().publicKey.toBase58(),
      name,
      symbol,
      createdMs: Date.now() - 90_000 * (i + 1),
      marketCapUsd: 5800 * (5 - i),
      changePct: 8.4 - i * 4,
      volumeUsd: 2400 / (i + 1),
      traders: 9 - i,
      progressPct: 31 + i * 12,
    });
  }
  out.trending = await call("GET", "/ui/list?kind=trending");
  out.newCoins = await call("GET", "/ui/list?kind=new");

  // A coin being created, with its photo.
  fs.writeFileSync(path.join(tmp, "coin-fixture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  await call("POST", "/ui/launch/set", { field: "image", value: "coin-fixture.png" });
  await call("POST", "/ui/launch/set", { field: "name", value: "Downtown" });
  await call("POST", "/ui/launch/set", { field: "symbol", value: "DTWN" });
  await call("POST", "/ui/launch/set", { field: "description", value: "Next stop: the moon. Every bus in Los Santos runs on it." });
  out.launchReady = await call("GET", "/ui/launch");
  out.launchConfirm = await call("POST", "/ui/launch/review");

  // The wallet's own screens, from a first run through to unlocking again.
  const kdf = { N: 2 ** 10, r: 8, p: 1 };
  const password = "fixture password";
  let file: KeystoreFile | null = null;
  const store: WalletStore = {
    exists: () => file !== null,
    read: () => file!,
    save: (f) => {
      file = f;
    },
    remove: () => {
      file = null;
    },
  };
  const noWallet: WalletStore = { exists: () => false, read: () => { throw new Error("no wallet"); }, save: () => {}, remove: () => {} };
  const makeGate = (wallets = store) =>
    new WalletGate({
      config: { ...DEFAULT_CONFIG },
      store: wallets,
      kdf,
      saveConfig: () => {},
      copy: async () => {},
      paste: async () => "",
      connection,
      engine: new PumpEngine(connection, DEFAULT_CONFIG.slippagePercent),
      meta: new MetaResolver(connection),
      history: new History(path.join(tmp, "history.jsonl")),
      newKeypair: () => wallet,
      makeApp: () => app,
    });
  const first = makeGate();
  const gateCall = async (gate: WalletGate, method: string, p: string, body: Record<string, unknown> = {}) =>
    (await gate.handle(method, new URL(p, "http://127.0.0.1"), body)) as UiResponse;
  out.welcome = await gateCall(first, "GET", "/ui/home");
  out.repeat = await gateCall(first, "POST", "/ui/setup/password", { password });
  out.created = await gateCall(first, "POST", "/ui/setup/confirm", { password });
  out.deposit = await gateCall(first, "GET", "/ui/deposit");
  out.backup = await gateCall(first, "GET", "/ui/backup");
  out.secretKey = await gateCall(first, "POST", "/ui/backup/reveal", { password });
  out.mode = await gateCall(first, "GET", "/ui/mode");
  const friend = Keypair.generate().publicKey.toBase58();
  out.sendAssets = await gateCall(first, "GET", "/ui/send");
  out.sendTo = await gateCall(first, "GET", `/ui/send/to?asset=${m}`);
  out.sendAmount = await gateCall(first, "POST", "/ui/send/address", { asset: "SOL", to: friend });
  fc.lamports.set(friend, 5_000_000);
  out.sendReview = await gateCall(first, "POST", "/ui/send/review", { asset: "SOL", to: friend, percent: 25 });
  out.swap = await gateCall(first, "GET", "/ui/swap");
  out.swapPick = await gateCall(first, "GET", "/ui/swap/pick?side=to");
  out.swapQuoted = await gateCall(first, "POST", "/ui/swap/amount", { amount: "0.1" });
  out.swapConfirm = await gateCall(first, "POST", "/ui/swap/review");
  out.swapCoin = await gateCall(first, "GET", `/ui/swap?mint=${m}`);
  out.activity = await gateCall(first, "GET", "/ui/history");
  await gateCall(first, "POST", "/ui/swap/set", { side: "to", mint: USDC_MINT, stay: true });
  out.settings = await gateCall(first, "GET", "/ui/settings");
  out.limit = await gateCall(first, "GET", "/ui/settings/max");
  out.raiseLimit = await gateCall(first, "POST", "/ui/settings/set", { kind: "max", value: 1 });
  out.rpc = await gateCall(first, "GET", "/ui/settings/rpc");
  out.reset = await gateCall(first, "GET", "/ui/reset");
  out.unlock = await gateCall(makeGate(), "GET", "/ui/home");
  out.forgot = await gateCall(makeGate(), "GET", "/ui/reset/forgot");
  out.welcomeImport = await gateCall(makeGate(noWallet), "GET", "/ui/setup/import");

  for (const [name, res] of Object.entries(out)) {
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(res));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`wrote ${Object.keys(out).length} fixtures to ${outDir}`);
}

main(process.argv[2] ?? "fixtures").catch((e) => {
  console.error(e);
  process.exit(1);
});
