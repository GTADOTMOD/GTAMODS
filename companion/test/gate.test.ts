import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Config, DEFAULT_CONFIG, validateConfig } from "../src/config.js";
import { WalletGate, WalletStore, qrModules } from "../src/gate.js";
import { Jupiter } from "../src/jupiter.js";
import { KeystoreFile, encryptKeypair } from "../src/keystore.js";
import { MetaResolver } from "../src/metadata.js";
import { watchParent } from "../src/parent.js";
import { SolPrice } from "../src/price.js";
import { PumpEngine } from "../src/pump.js";
import { RugrApi } from "../src/rugr.js";
import { History, Watchlist } from "../src/store.js";
import { TokenDirectory, USDC_MINT } from "../src/tokens.js";
import { Action, PhoneApp, UiResponse, fromRawAmount, toRawAmount } from "../src/ui.js";
import { FakeConnection, fakeJupiterFetch, fakeRugrFetch, fakeTokensFetch, seedChain } from "./fakeChain.js";

const KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = "correct horse battery";

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pumpv-gate-"));
  fs.mkdirSync(path.join(tmp, "images"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function memoryStore(initial: KeystoreFile | null = null): WalletStore & { file: () => KeystoreFile | null } {
  let file = initial;
  return {
    exists: () => file !== null,
    read: () => file!,
    save: (f) => {
      file = f;
    },
    remove: () => {
      file = null;
    },
    file: () => file,
  };
}

function makeGate(store: WalletStore, overrides: Partial<Config> = {}, world: { fc?: FakeConnection; clipboard?: string; jupiter?: Jupiter } = {}) {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides };
  const fc = world.fc ?? new FakeConnection();
  const connection = fc.asConnection();
  const copied: string[] = [];
  const logged: string[] = [];
  const saved: Config[] = [];
  const sent: unknown[] = [];
  const clipboard = { text: world.clipboard ?? "" };
  const engine = new PumpEngine(connection, config.slippagePercent);
  const meta = new MetaResolver(connection);
  const history = new History(path.join(tmp, `history-${Math.random()}.jsonl`));
  const send = async (_c: unknown, built: unknown) => {
    sent.push(built);
    return "RealSignature1111111111111111111111";
  };
  const paste = async () => clipboard.text;
  const gate = new WalletGate({
    config,
    store,
    kdf: KDF,
    connection,
    engine,
    meta,
    history,
    paste,
    send,
    copy: async (text) => {
      copied.push(text);
    },
    saveConfig: (c) => saved.push({ ...c }),
    log: (m) => logged.push(m),
    makeApp: (wallet) =>
      new PhoneApp({
        config,
        connection,
        wallet,
        engine,
        api: new RugrApi("https://rugr.test", fakeRugrFetch()),
        meta,
        price: new SolPrice(connection),
        history,
        watchlist: new Watchlist(path.join(tmp, `watch-${Math.random()}.json`)),
        imagesDir: path.join(tmp, "images"),
        jupiter: world.jupiter,
        tokens: new TokenDirectory(fakeTokensFetch()),
        paste,
        send,
      }),
  });
  const call = async (method: string, p: string, body: Record<string, unknown> = {}): Promise<UiResponse> => {
    const res = await gate.handle(method, new URL(p, "http://127.0.0.1"), body);
    assert.ok(res, `route ${method} ${p} exists`);
    return res!;
  };
  return { gate, call, config, copied, logged, saved, sent, clipboard, history, fc };
}

const texts = (r: UiResponse) => r.screen!.rows.map((x) => x.text);

function actionOf(r: UiResponse, text: string): Action {
  const a = r.screen!.rows.find((x) => x.text === text)?.action;
  assert.ok(a, `"${text}" in [${texts(r).join(" | ")}]`);
  return a!;
}

async function createWallet(call: ReturnType<typeof makeGate>["call"], password = PASSWORD): Promise<UiResponse> {
  await call("POST", "/ui/setup/password", { password });
  return call("POST", "/ui/setup/confirm", { password });
}

describe("wallet gate", () => {
  it("first run: offers to create a wallet and reaches nothing else", async () => {
    const { call } = makeGate(memoryStore());
    const home = await call("GET", "/ui/home");
    assert.equal(home.screen!.header, "Set up your wallet");
    const create = actionOf(home, "Create wallet");
    assert.equal(create.kind, "secret");
    assert.equal((create as Extract<Action, { kind: "secret" }>).path, "/ui/setup/password");

    for (const p of ["/ui/wallet", "/ui/list?kind=new", "/ui/backup", "/ui/deposit", "/ui/mode"]) {
      assert.equal((await call("GET", p)).screen!.header, "Set up your wallet", p);
    }
    for (const p of ["/ui/execute", "/ui/quote/buy", "/ui/backup/reveal", "/ui/mode/real", "/ui/wallet/copy-address"]) {
      const res = await call("POST", p, { password: PASSWORD });
      assert.equal(res.nav, "home", p);
      assert.equal(res.toast?.level, "error", p);
    }
  });

  it("rejects a short password and a mismatch without saving anything", async () => {
    const store = memoryStore();
    const { call } = makeGate(store);
    const short = await call("POST", "/ui/setup/password", { password: "GTADOTFUN" });
    assert.match(short.toast!.text, /at least 10/);
    assert.equal(short.nav, "none");

    await call("POST", "/ui/setup/password", { password: PASSWORD });
    const mismatch = await call("POST", "/ui/setup/confirm", { password: "something different" });
    assert.equal(mismatch.nav, "back");
    assert.match(mismatch.toast!.text, /didn't match/);
    assert.equal(store.file(), null);

    const again = await call("POST", "/ui/setup/confirm", { password: PASSWORD });
    assert.equal(again.nav, "home", "a mismatch means choosing the password again");
    assert.equal(store.file(), null);
  });

  it("keeps a password exactly as typed, spaces included", async () => {
    const store = memoryStore();
    const a = makeGate(store);
    await createWallet(a.call, "  spaces matter  ");
    const b = makeGate(store);
    assert.match((await b.call("POST", "/ui/unlock", { password: "spaces matter" })).toast!.text, /Wrong password/);
    assert.equal((await b.call("POST", "/ui/unlock", { password: "  spaces matter  " })).nav, "home");
  });

  it("creating saves only an encrypted wallet, and leads to funding and backup", async () => {
    const store = memoryStore();
    const { call, logged } = makeGate(store);
    const created = await createWallet(call);
    assert.equal(created.nav, "replace");
    assert.equal(created.screen!.header, "Wallet created");
    assert.ok(actionOf(created, "Export private key"));
    assert.equal(actionOf(created, "Continue").kind, "home");

    const file = store.file()!;
    assert.ok(file.address.length > 30);
    assert.equal(JSON.stringify(file).includes(PASSWORD), false);

    const home = await call("GET", "/ui/home");
    assert.equal(home.screen!.header, "RUGR", "unlocked: the real app answers");
    assert.ok(texts(home).some((t) => t.startsWith("Wallet")));
    assert.deepEqual(logged, []);
  });

  it("won't overwrite a wallet that exists", async () => {
    const wallet = Keypair.generate();
    const store = memoryStore(encryptKeypair(wallet, PASSWORD, KDF));
    const { call } = makeGate(store);
    const before = store.file();
    assert.equal((await call("POST", "/ui/setup/password", { password: "another password" })).toast!.level, "error");
    assert.equal((await call("POST", "/ui/setup/confirm", { password: "another password" })).toast!.level, "error");
    assert.equal(store.file(), before);
  });

  it("returning: asks for the password, then opens the app", async () => {
    const wallet = Keypair.generate();
    const { call, logged } = makeGate(memoryStore(encryptKeypair(wallet, PASSWORD, KDF)));
    const home = await call("GET", "/ui/home");
    assert.equal(home.screen!.header, "Unlock wallet");
    assert.equal(actionOf(home, "Enter password").kind, "secret");

    const wrong = await call("POST", "/ui/unlock", { password: "not the password" });
    assert.equal(wrong.nav, "none");
    assert.match(wrong.toast!.text, /Wrong password/);
    assert.equal((await call("GET", "/ui/wallet")).screen!.header, "Unlock wallet", "still locked");

    assert.equal((await call("POST", "/ui/unlock", { password: PASSWORD })).nav, "home");
    assert.equal((await call("GET", "/ui/wallet")).screen!.header, "Wallet");
    assert.deepEqual(logged, []);
  });

  it("showing the key needs the password, every time", async () => {
    const wallet = Keypair.generate();
    const secret = bs58.encode(wallet.secretKey);
    const { call, copied } = makeGate(memoryStore(encryptKeypair(wallet, PASSWORD, KDF)));
    await call("POST", "/ui/unlock", { password: PASSWORD });

    const backup = await call("GET", "/ui/backup");
    assert.equal(backup.screen!.rows[backup.screen!.selected].text, "Cancel", "highlight starts on Cancel");
    assert.equal(JSON.stringify(backup).includes(secret), false);

    const wrong = await call("POST", "/ui/backup/reveal", { password: "not the password" });
    assert.match(wrong.toast!.text, /Wrong password/);
    assert.equal(JSON.stringify(wrong).includes(secret), false);

    const shown = await call("POST", "/ui/backup/reveal", { password: PASSWORD });
    assert.equal(shown.screen!.path, "", "never fetched again");
    assert.equal(shown.screen!.rows.slice(1, -2).map((r) => r.text).join(""), secret, "the whole key, split over rows");
    assert.ok(shown.screen!.rows.every((r) => r.text.length <= 34), "rows fit the phone");

    const copy = actionOf(shown, "Copy key") as Extract<Action, { kind: "post" }>;
    assert.match((await call("POST", copy.path, { ticket: "made up" })).toast!.text, /expired/);
    assert.deepEqual(copied, []);
    assert.equal((await call("POST", copy.path, copy.body)).toast!.level, "success");
    assert.deepEqual(copied, [secret]);
    assert.match((await call("POST", copy.path, copy.body)).toast!.text, /expired/, "a ticket works once");
    assert.deepEqual(copied, [secret]);
  });

  it("copies the address and shows it as a QR code", async () => {
    const wallet = Keypair.generate();
    const { call, copied } = makeGate(memoryStore(encryptKeypair(wallet, PASSWORD, KDF)));
    await call("POST", "/ui/unlock", { password: PASSWORD });
    assert.equal((await call("POST", "/ui/wallet/copy-address")).toast!.level, "success");
    assert.deepEqual(copied, [wallet.publicKey.toBase58()]);

    const style = (await call("GET", "/ui/deposit")).screen!.rows[0].style as { kind: string; modules: string[] };
    assert.equal(style.kind, "qr");
    assert.ok(style.modules.every((m) => m.length === style.modules.length && /^[01]+$/.test(m)), "a square of 0s and 1s");
    assert.ok(style.modules.length <= 33, `small enough to scan off the phone (${style.modules.length})`);
  });

  it("real money needs the password; going back to practice doesn't", async () => {
    const wallet = Keypair.generate();
    const { call, config, saved } = makeGate(memoryStore(encryptKeypair(wallet, PASSWORD, KDF)));
    await call("POST", "/ui/unlock", { password: PASSWORD });
    assert.equal(config.dryRun, true, "starts in practice");

    const mode = await call("GET", "/ui/mode");
    assert.equal(mode.screen!.rows[mode.screen!.selected].text, "Stay in Practice", "highlight starts on staying");
    assert.equal(actionOf(mode, "Use real money").kind, "secret");

    assert.match((await call("POST", "/ui/mode/real", { password: "not the password" })).toast!.text, /Wrong password/);
    assert.match((await call("POST", "/ui/mode/real")).toast!.text, /Wrong password/);
    assert.equal(config.dryRun, true);
    assert.equal(saved.length, 0);

    const on = await call("POST", "/ui/mode/real", { password: PASSWORD });
    assert.equal(on.nav, "back");
    assert.ok(texts(on).includes("Mode Real money"), "back on Settings, showing it");
    assert.equal(config.dryRun, false);
    assert.equal(saved.at(-1)!.dryRun, false, "survives a restart");

    await call("POST", "/ui/mode/practice");
    assert.equal(config.dryRun, true);
    assert.equal(saved.at(-1)!.dryRun, true);
  });
});

async function unlockedWorld(overrides: Partial<Config> = {}, jupiterOpts: Parameters<typeof fakeJupiterFetch>[1] = {}, seed: Parameters<typeof seedChain>[2] = {}) {
  const wallet = Keypair.generate();
  const fc = new FakeConnection();
  const { mint } = await seedChain(fc, wallet.publicKey, seed);
  const world = makeGate(memoryStore(encryptKeypair(wallet, PASSWORD, KDF)), overrides, {
    fc,
    jupiter: new Jupiter(fakeJupiterFetch(wallet.publicKey, jupiterOpts)),
  });
  await world.call("POST", "/ui/unlock", { password: PASSWORD });
  return { ...world, wallet, mint, m: mint.toBase58() };
}

function postOf(r: UiResponse, text: string): { path: string; body: Record<string, unknown> } {
  const a = actionOf(r, text) as Extract<Action, { kind: "post" }>;
  assert.equal(a.kind, "post", text);
  return { path: a.path, body: a.body ?? {} };
}

describe("settings", () => {
  const unlocked = async (overrides: Partial<Config> = {}) => {
    const wallet = Keypair.generate();
    const store = memoryStore(encryptKeypair(wallet, PASSWORD, KDF));
    const world = makeGate(store, overrides);
    await world.call("POST", "/ui/unlock", { password: PASSWORD });
    return { ...world, wallet, store };
  };
  const screenFits = (r: UiResponse) => assert.ok(!texts(r).some((t) => t.endsWith("..")), `nothing cut off in [${texts(r).join(" | ")}]`);

  it("has what a wallet needs, and isn't reachable while locked", async () => {
    const { call, gate } = await unlocked();
    const s = await call("GET", "/ui/settings");
    screenFits(s);
    for (const name of ["Export private key", "Change password", "Lock wallet", "Reset wallet"]) assert.ok(texts(s).includes(name), name);
    for (const start of ["Copy address", "Mode Practice", "Slippage 10%", "Max per trade 0.5 SOL", "RPC RUGR"]) {
      assert.ok(texts(s).some((t) => t.startsWith(start)), start);
    }
    assert.equal((s.screen!.rows.find((r) => r.text === "Reset wallet")!.style as { tone: string }).tone, "danger");

    await call("POST", "/ui/lock");
    for (const p of ["/ui/settings", "/ui/settings/max", "/ui/settings/rpc", "/ui/reset"]) {
      assert.equal((await call("GET", p)).screen!.header, "Unlock wallet", p);
    }
    for (const p of ["/ui/settings/set", "/ui/settings/rpc/set", "/ui/settings/password/current", "/ui/reset/confirm", "/ui/lock"]) {
      assert.equal((await gate.handle("POST", new URL(p, "http://127.0.0.1"), { password: PASSWORD }))!.nav, "home", p);
    }
  });

  it("locking asks for the password again and keeps the wallet", async () => {
    const { call, store } = await unlocked();
    const locked = await call("POST", "/ui/lock");
    assert.equal(locked.nav, "home");
    assert.equal((await call("GET", "/ui/wallet")).screen!.header, "Unlock wallet");
    assert.ok(store.file(), "the wallet is still there");
    await call("POST", "/ui/unlock", { password: PASSWORD });
    assert.equal((await call("GET", "/ui/wallet")).screen!.header, "Wallet");
  });

  it("changing the password needs the old one and the new one twice", async () => {
    const { call, store, wallet } = await unlocked();
    assert.match((await call("POST", "/ui/settings/password/current", { password: "not the password" })).toast!.text, /Wrong password/);
    assert.match((await call("POST", "/ui/settings/password/new", { password: "a new password", ticket: "made up" })).toast!.text, /expired/);

    const first = await call("POST", "/ui/settings/password/current", { password: PASSWORD });
    const choose = actionOf(first, "Choose new password") as Extract<Action, { kind: "secret" }>;
    assert.equal(choose.kind, "secret");
    assert.match((await call("POST", choose.path, { ...choose.body, password: "short" })).toast!.text, /at least 10/);

    const NEW = "a brand new password";
    const repeatScreen = await call("POST", choose.path, { ...choose.body, password: NEW });
    const repeat = actionOf(repeatScreen, "Repeat password") as Extract<Action, { kind: "secret" }>;
    const before = store.file();
    const mismatch = await call("POST", repeat.path, { ...repeat.body, password: "something else entirely" });
    assert.match(mismatch.toast!.text, /didn't match/);
    assert.equal(mismatch.screen!.header, "New password", "starts the new one over");
    assert.equal(store.file(), before);

    const again = actionOf(mismatch, "Choose new password") as Extract<Action, { kind: "secret" }>;
    const repeat2 = actionOf(await call("POST", again.path, { ...again.body, password: NEW }), "Repeat password") as Extract<Action, { kind: "secret" }>;
    const done = await call("POST", repeat2.path, { ...repeat2.body, password: NEW });
    assert.equal(done.nav, "back");
    assert.equal(done.screen!.header, "Settings");
    assert.match((await call("POST", repeat2.path, { ...repeat2.body, password: NEW })).toast!.text, /expired/, "a ticket works once");

    const fresh = makeGate(store);
    assert.match((await fresh.call("POST", "/ui/unlock", { password: PASSWORD })).toast!.text, /Wrong password/);
    assert.equal((await fresh.call("POST", "/ui/unlock", { password: NEW })).nav, "home");
    assert.equal(store.file()!.address, wallet.publicKey.toBase58(), "the same wallet");
  });

  it("resetting warns, starts on Cancel, needs the password, and leaves a clean start", async () => {
    const { call, store, history, config, saved, wallet } = await unlocked({ dryRun: false });
    history.append({ ts: 1, kind: "buy", mint: "m", sol: 1, tokens: 1, simulated: false });
    const s = await call("GET", "/ui/reset");
    screenFits(s);
    assert.equal(s.screen!.rows[s.screen!.selected].text, "Cancel");
    assert.ok(texts(s).includes("Export private key first"));
    assert.ok(texts(s).some((t) => t.startsWith("It holds")));

    assert.match((await call("POST", "/ui/reset/confirm", { password: "not the password" })).toast!.text, /Wrong password/);
    assert.ok(store.file(), "still there");
    assert.equal((await call("GET", "/ui/wallet")).screen!.header, "Wallet", "still unlocked");

    const done = await call("POST", "/ui/reset/confirm", { password: PASSWORD });
    assert.equal(done.nav, "home");
    assert.match(done.toast!.text, /encrypted copy/);
    assert.equal(store.file(), null);
    assert.equal((await call("GET", "/ui/home")).screen!.header, "Set up your wallet");
    assert.deepEqual(history.recent(5), [], "Activity starts over");
    assert.equal(config.dryRun, true, "back in Practice");
    assert.equal(saved.at(-1)!.dryRun, true);

    await createWallet(call, "a different password");
    assert.notEqual(store.file()!.address, wallet.publicKey.toBase58(), "and a new wallet can be made");
  });

  it("a forgotten password can reset, but only by typing the word, and only while locked", async () => {
    const wallet = Keypair.generate();
    const store = memoryStore(encryptKeypair(wallet, PASSWORD, KDF));
    const { call } = makeGate(store);
    const unlock = await call("GET", "/ui/home");
    assert.deepEqual(actionOf(unlock, "Forgot password"), { kind: "open", path: "/ui/reset/forgot" });
    const forgot = await call("GET", "/ui/reset/forgot");
    screenFits(forgot);
    assert.equal(forgot.screen!.rows[forgot.screen!.selected].text, "Cancel");

    assert.match((await call("POST", "/ui/reset/forgot", { confirm: "yes" })).toast!.text, /Nothing changed/);
    assert.ok(store.file());

    await call("POST", "/ui/unlock", { password: PASSWORD });
    assert.equal((await call("POST", "/ui/reset/forgot", { confirm: "RESET" })).nav, "home");
    assert.ok(store.file(), "an open wallet needs its password to reset");

    await call("POST", "/ui/lock");
    assert.equal((await call("POST", "/ui/reset/forgot", { confirm: " reset " })).nav, "home");
    assert.equal(store.file(), null);
  });

  it("imports a wallet from the clipboard, then forgets the clipboard", async () => {
    const wallet = Keypair.generate();
    const secret = bs58.encode(wallet.secretKey);
    const store = memoryStore();
    const { call, clipboard, copied } = makeGate(store);
    assert.deepEqual(actionOf(await call("GET", "/ui/home"), "Import a wallet"), { kind: "open", path: "/ui/setup/import" });
    screenFits(await call("GET", "/ui/setup/import"));

    clipboard.text = "my secret nonsense";
    const bad = await call("POST", "/ui/setup/import");
    assert.match(bad.toast!.text, /isn't a private key/);
    assert.equal(JSON.stringify(bad).includes("nonsense"), false, "never repeats what was pasted");

    clipboard.text = `  ${secret}\n`;
    const ask = await call("POST", "/ui/setup/import");
    assert.ok(texts(ask).some((t) => t.includes(wallet.publicKey.toBase58().slice(0, 4))), "shows which wallet it is");
    assert.equal(JSON.stringify(ask).includes(secret), false);
    assert.deepEqual(copied, [""], "clears the clipboard");

    await call("POST", "/ui/setup/password", { password: PASSWORD });
    const done = await call("POST", "/ui/setup/confirm", { password: PASSWORD });
    assert.equal(done.nav, "home");
    assert.equal(store.file()!.address, wallet.publicKey.toBase58());
    assert.equal(JSON.stringify(store.file()).includes(secret), false);
    assert.equal((await call("GET", "/ui/home")).screen!.header, "RUGR");

    clipboard.text = bs58.encode(Keypair.generate().secretKey);
    assert.match((await call("POST", "/ui/setup/import")).toast!.text, /already exists/);
    assert.equal(store.file()!.address, wallet.publicKey.toBase58());
  });

  it("going back from an import forgets the key", async () => {
    const store = memoryStore();
    const { call, clipboard } = makeGate(store);
    clipboard.text = bs58.encode(Keypair.generate().secretKey);
    await call("POST", "/ui/setup/import");
    await call("GET", "/ui/home");
    await createWallet(call);
    assert.ok(store.file(), "made a new wallet");
  });

  it("lowering a limit is free, raising one needs the password", async () => {
    const { call, config, saved } = await unlocked();
    const low = await call("POST", "/ui/settings/set", { kind: "max", value: 0.1 });
    assert.equal(low.nav, "back");
    assert.equal(low.screen!.header, "Settings");
    assert.equal(config.maxSolPerTrade, 0.1);
    assert.equal(saved.at(-1)!.maxSolPerTrade, 0.1);
    assert.ok(config.buyPresetsSol.every((p) => p <= 0.1), "buy buttons stay inside the limit");
    assert.doesNotThrow(() => validateConfig(saved.at(-1)), "and it loads next time");

    const raise = await call("POST", "/ui/settings/set", { kind: "max", value: 1 });
    assert.equal(raise.nav, "replace");
    assert.equal(config.maxSolPerTrade, 0.1, "not yet");
    screenFits(raise);
    const ask = actionOf(raise, "Enter password") as Extract<Action, { kind: "secret" }>;
    assert.equal(ask.kind, "secret");
    assert.match((await call("POST", ask.path, { ...ask.body, password: "not the password" })).toast!.text, /Wrong password/);
    assert.equal(config.maxSolPerTrade, 0.1);

    assert.equal((await call("POST", ask.path, { ...ask.body, password: PASSWORD })).nav, "back");
    assert.equal(config.maxSolPerTrade, 1);
    assert.ok(config.buyPresetsSol.includes(0.25), "the buy buttons come back");
    assert.doesNotThrow(() => validateConfig(saved.at(-1)));
  });

  it("slippage reaches the trades at once, and nonsense is refused", async () => {
    const { call, config } = await unlocked();
    const screenNow = await call("GET", "/ui/settings/slippage");
    screenFits(screenNow);
    assert.equal(screenNow.screen!.rows[screenNow.screen!.selected].text, "10%", "starts on the current one");
    await call("POST", "/ui/settings/set", { kind: "slippage", value: 5 });
    assert.equal(config.slippagePercent, 5);
    assert.ok(texts(await call("GET", "/ui/settings")).includes("Slippage 5%"), "read back from the trade engine");

    for (const value of ["abc", "0", "-1", "51", ""]) {
      assert.match((await call("POST", "/ui/settings/set", { kind: "slippage", value })).toast!.text, /from 0\.1 to 50/, value);
    }
    assert.equal(config.slippagePercent, 5);
  });

  it("changing the RPC checks the address and needs the password", async () => {
    const { call, config, clipboard, saved } = await unlocked();
    screenFits(await call("GET", "/ui/settings/rpc"));
    clipboard.text = "http://not-secure.example.com";
    assert.match((await call("POST", "/ui/settings/rpc/paste")).toast!.text, /isn't an https/);

    clipboard.text = "https://rpc.example.com/?api-key=abc";
    const ask = await call("POST", "/ui/settings/rpc/paste");
    screenFits(ask);
    assert.ok(texts(ask).includes("New RPC rpc.example.com"), "shows the host, not the key");
    const enter = actionOf(ask, "Enter password") as Extract<Action, { kind: "secret" }>;
    assert.match((await call("POST", enter.path, { ...enter.body, password: "not the password" })).toast!.text, /Wrong password/);
    assert.equal(config.rpcUrl, DEFAULT_CONFIG.rpcUrl);

    const done = await call("POST", enter.path, { ...enter.body, password: PASSWORD });
    assert.equal(done.nav, "back");
    assert.equal(config.rpcUrl, "https://rpc.example.com/?api-key=abc");
    assert.equal(saved.at(-1)!.rpcUrl, config.rpcUrl);
    assert.ok(texts(await call("GET", "/ui/settings/rpc")).includes("Use RUGR's RPC"));
  });

  it("every screen's words fit the phone", async () => {
    const { call } = await unlocked();
    for (const p of ["/ui/settings", "/ui/settings/max", "/ui/settings/rpc", "/ui/reset", "/ui/backup", "/ui/mode"]) screenFits(await call("GET", p));
  });
});

describe("swap", () => {
  /** Fills the form in: pay some SOL, for this token. */
  async function fill(call: ReturnType<typeof makeGate>["call"], m: string, amount = "0.1"): Promise<UiResponse> {
    await call("POST", "/ui/swap/set", { side: "to", mint: m, stay: true });
    return call("POST", "/ui/swap/amount", { amount });
  }
  const style = (r: UiResponse, kind: string) => r.screen!.rows.filter((x) => x.style?.kind === kind).map((x) => x.style as Record<string, any>);

  it("starts as SOL for USDC, ready to type an amount", async () => {
    const { call } = await unlockedWorld();
    const s = await call("GET", "/ui/swap");
    assert.equal(s.screen!.tab, true);
    assert.deepEqual(style(s, "tokenPill").map((p) => p.symbol), ["SOL", "USDC"]);
    assert.deepEqual(style(s, "swapAmount").map((a) => a.label), ["You pay", "You receive"]);
    assert.equal(s.screen!.rows[s.screen!.selected].style?.kind, "swapAmount");
    assert.ok(!texts(s).includes("Review swap"), "nothing to review yet");
    assert.equal(s.screen!.refreshMs, 0, "nothing to keep quoting");
    assert.equal(s.screen!.rows.findIndex((r) => r.text === "Flip") > 0, true);
  });

  it("pasting a token's address fills it in; anything else is explained", async () => {
    const { call, clipboard, m } = await unlockedWorld();
    clipboard.text = "not an address";
    assert.match((await call("POST", "/ui/swap/paste", { side: "to" })).toast!.text, /Copy a token address first/);

    clipboard.text = Keypair.generate().publicKey.toBase58();
    assert.match((await call("POST", "/ui/swap/paste", { side: "to" })).toast!.text, /isn't a token address/);

    clipboard.text = `  ${m}\n`;
    const picked = await call("POST", "/ui/swap/paste", { side: "to" });
    assert.equal(picked.nav, "back", "from the picker, back to the form");
    assert.equal(style(picked, "tokenPill")[1].mint, m, "already showing the new token");

    const here = await call("POST", "/ui/swap/paste", { side: "to", stay: true });
    assert.equal(here.nav, "replace", "from the form itself, stays put");
  });

  it("the picker lists SOL, what you hold and well-known tokens", async () => {
    const { call, m } = await unlockedWorld({}, {}, { holdTokens: BigInt("10000000000000") });
    const pick = await call("GET", "/ui/swap/pick?side=from");
    const mints = style(pick, "asset").map((a) => a.mint);
    assert.equal(style(pick, "asset")[0].symbol, "SOL");
    assert.ok(mints.includes(m), "a coin in the wallet");
    assert.ok(mints.includes(USDC_MINT));
    assert.ok(texts(pick).includes("Paste token address"));
    const action = pick.screen!.rows.find((r) => r.style?.kind === "asset" && (r.style as { mint: string }).mint === m)!.action as Extract<Action, { kind: "post" }>;
    assert.deepEqual(action.body, { side: "from", mint: m });
  });

  it("quotes as soon as there's an amount, and shows dollars from real prices", async () => {
    const { call, m } = await unlockedWorld({}, { outAmount: "5000000000" });
    const s = await fill(call, m);
    assert.equal(s.screen!.rows[s.screen!.selected].text, "Review swap", "the highlight moves on to what's next");
    const [pay, get] = style(s, "swapAmount");
    assert.equal(pay.value, "0.1");
    assert.equal(pay.usd, "$9.58");
    assert.equal(get.value, "5000");
    assert.ok(s.screen!.refreshMs > 0, "keeps the quote fresh");
  });

  it("50%, 100% and flip work the form", async () => {
    const { call, m, fc, wallet } = await unlockedWorld({}, {}, { holdTokens: BigInt("10000000000000"), userLamports: 1_010_000_000 });
    const half = await call("POST", "/ui/swap/amount", { percent: 50 });
    assert.equal(style(half, "swapAmount")[0].value, "0.5", "half of what's left after fees");
    const all = await call("POST", "/ui/swap/amount", { percent: 100 });
    assert.equal(style(all, "swapAmount")[0].value, "1", "SOL keeps 0.01 back for fees");
    assert.equal(await fc.getBalance(wallet.publicKey), 1_010_000_000, "only the form changed");

    await call("POST", "/ui/swap/set", { side: "to", mint: m, stay: true });
    const flipped = await call("POST", "/ui/swap/flip");
    assert.equal(flipped.nav, "replace");
    assert.equal(style(flipped, "tokenPill")[0].mint, m);
    assert.equal(style(flipped, "tokenPill")[1].symbol, "SOL");
    assert.equal(style(flipped, "swapAmount")[0].value, "0", "the old amount meant another token");

    const coinAll = await call("POST", "/ui/swap/amount", { percent: 100 });
    assert.equal(style(coinAll, "swapAmount")[0].value, "10000000", "a token can all go; fees are paid in SOL");
  });

  it("picking the token already on the other side swaps them round", async () => {
    const { call } = await unlockedWorld();
    const s = await call("POST", "/ui/swap/set", { side: "to", mint: "So11111111111111111111111111111111111111112", stay: true });
    assert.deepEqual(style(s, "tokenPill").map((p) => p.symbol), ["USDC", "SOL"]);
  });

  it("a token from elsewhere in the app opens filled in", async () => {
    const { call, m } = await unlockedWorld();
    const buying = await call("GET", `/ui/swap?mint=${m}`);
    assert.equal(style(buying, "tokenPill")[1].mint, m);
    assert.equal(style(buying, "tokenPill")[0].symbol, "SOL");
    assert.equal(buying.screen!.path, "/ui/swap", "refreshing doesn't fill it in again");

    const selling = await call("GET", `/ui/swap?mint=${m}&side=from`);
    assert.equal(style(selling, "tokenPill")[0].mint, m);
    assert.equal(style(selling, "tokenPill")[1].symbol, "SOL");
  });

  it("a practice swap shows the numbers, then simulates without sending", async () => {
    const { call, m, sent, history, fc } = await unlockedWorld();
    await fill(call, m);
    const confirm = await call("POST", "/ui/swap/review");
    assert.equal(confirm.screen!.header, "Confirm swap");
    assert.equal(confirm.screen!.rows[confirm.screen!.selected].text, "Cancel", "highlight starts on Cancel");
    assert.ok(texts(confirm).some((t) => t.startsWith("At least")));

    const { path: p, body } = postOf(confirm, "SIMULATE SWAP");
    const before = fc.simulated.length;
    const done = await call("POST", p, body);
    assert.equal(done.screen!.header, "Simulated swap");
    assert.equal(fc.simulated.length, before + 1);
    assert.deepEqual(sent, []);
    assert.equal(history.recent(1)[0].kind, "swap");
    assert.match((await call("POST", p, body)).toast!.text, /expired/, "a confirm works once");
    assert.equal(style(await call("GET", "/ui/swap"), "swapAmount")[0].value, "0", "ready for the next one");
  });

  it("a real swap signs and sends what it checked", async () => {
    const { call, m, sent, wallet } = await unlockedWorld({ dryRun: false });
    await fill(call, m);
    const { path: p, body } = postOf(await call("POST", "/ui/swap/review"), "CONFIRM SWAP");
    const done = await call("POST", p, body);
    assert.equal(done.screen!.header, "Swapped");
    assert.equal(sent.length, 1);
    const { tx } = sent[0] as { tx: { signatures: Uint8Array[]; message: { staticAccountKeys: { equals(k: unknown): boolean }[] } } };
    assert.ok(tx.message.staticAccountKeys[0].equals(wallet.publicKey));
    assert.ok(tx.signatures[0].some((b) => b !== 0), "signed");
  });

  it("a token-for-token swap may only cost fees in SOL", async () => {
    const { call, m, sent, fc, wallet } = await unlockedWorld({ dryRun: false }, {}, { holdTokens: BigInt("10000000000000") });
    await call("POST", "/ui/swap/set", { side: "from", mint: m, stay: true });
    await call("POST", "/ui/swap/amount", { percent: 50 });
    const confirm = await call("POST", "/ui/swap/review");
    fc.lamportsAfterSimulation = (await fc.getBalance(wallet.publicKey)) - 30_000_000; // 0.03 SOL gone
    const { path: p, body } = postOf(confirm, "CONFIRM SWAP");
    assert.match((await call("POST", p, body)).toast!.text, /more SOL than it showed/);
    assert.deepEqual(sent, []);
  });

  it("refuses a transaction for another wallet", async () => {
    const opts: Parameters<typeof fakeJupiterFetch>[1] = {};
    const { call, m, sent } = await unlockedWorld({ dryRun: false }, opts);
    await fill(call, m);
    const confirm = await call("POST", "/ui/swap/review");
    opts.payer = Keypair.generate().publicKey;
    const { path: p, body } = postOf(confirm, "CONFIRM SWAP");
    assert.match((await call("POST", p, body)).toast!.text, /another wallet/);
    assert.deepEqual(sent, []);
  });

  it("refuses a transaction that would take more SOL than it showed", async () => {
    const { call, m, sent, fc, wallet } = await unlockedWorld({ dryRun: false });
    await fill(call, m);
    const confirm = await call("POST", "/ui/swap/review");
    fc.lamportsAfterSimulation = (await fc.getBalance(wallet.publicKey)) - 500_000_000; // 0.5 SOL gone
    const { path: p, body } = postOf(confirm, "CONFIRM SWAP");
    assert.match((await call("POST", p, body)).toast!.text, /more SOL than it showed/);
    assert.deepEqual(sent, []);
  });

  it("stops if the price moved below the minimum shown", async () => {
    const opts: Parameters<typeof fakeJupiterFetch>[1] = {};
    const { call, m, sent } = await unlockedWorld({ dryRun: false }, opts);
    await fill(call, m);
    const confirm = await call("POST", "/ui/swap/review");
    opts.outAmount = "1000";
    const { path: p, body } = postOf(confirm, "CONFIRM SWAP");
    assert.match((await call("POST", p, body)).toast!.text, /Price moved/);
    assert.deepEqual(sent, []);
  });

  it("keeps the limits: per-trade cap, enough SOL, regular coins only, sells need a balance", async () => {
    const { call, m } = await unlockedWorld();
    const big = await fill(call, m, "9");
    assert.ok(texts(big).some((t) => /Max per trade/.test(t)), "the form says so");
    assert.ok(!texts(big).includes("Review swap"));
    assert.match((await call("POST", "/ui/swap/review")).toast!.text, /Max per trade/);

    await call("POST", "/ui/swap/set", { side: "from", mint: m, stay: true });
    assert.match((await call("POST", "/ui/swap/amount", { percent: 50 })).toast!.text, /You have no/);

    const broke = await unlockedWorld({}, {}, { userLamports: 1_000_000 });
    await fill(broke.call, broke.m);
    assert.match((await broke.call("POST", "/ui/swap/review")).toast!.text, /Not enough SOL/);

    const mayhem = await unlockedWorld({}, {}, { mayhem: true, holdTokens: BigInt("1000000000") });
    await fill(mayhem.call, mayhem.m);
    assert.match((await mayhem.call("POST", "/ui/swap/review")).toast!.text, /regular coins/);
    await mayhem.call("POST", "/ui/swap/flip");
    await mayhem.call("POST", "/ui/swap/amount", { percent: 100 });
    assert.equal((await mayhem.call("POST", "/ui/swap/review")).screen!.header, "Confirm swap", "but it can still be sold");
  });

  it("warns about high price impact and explains when there's no route", async () => {
    const high = await unlockedWorld({}, { priceImpact: 12 });
    await fill(high.call, high.m);
    assert.ok(texts(await high.call("POST", "/ui/swap/review")).some((t) => /High price impact/.test(t)));

    const none = await unlockedWorld({}, { error: "No routes found" });
    const form = await fill(none.call, none.m);
    assert.ok(texts(form).some((t) => /No way to swap/.test(t)), "said on the form");
    assert.equal(form.screen!.refreshMs, 3_000, "tries again soon");
    assert.match((await none.call("POST", "/ui/swap/review")).toast!.text, /No way to swap/);
  });
});

describe("send", () => {
  const to = Keypair.generate().publicKey.toBase58();

  it("practice: walks through to a simulation, showing the whole address, and sends nothing", async () => {
    const { call, clipboard, sent, history, fc } = await unlockedWorld();
    fc.lamports.set(to, 5_000_000);
    const assets = await call("GET", "/ui/send");
    assert.match(assets.screen!.rows[0].text, /^SOL/);

    clipboard.text = "nope";
    assert.match((await call("POST", "/ui/send/paste", { asset: "SOL" })).toast!.text, /isn't a wallet address/);
    clipboard.text = to;
    const amount = await call("POST", "/ui/send/paste", { asset: "SOL" });
    const half = postOf(amount, "Send 50%");
    const review = await call("POST", half.path, half.body);
    assert.equal(review.screen!.rows[review.screen!.selected].text, "Cancel");
    assert.ok(texts(review).join("").includes(to), `the full address, in [${texts(review).join(" | ")}]`);

    const go = postOf(review, "SIMULATE SEND");
    const before = fc.simulated.length;
    const done = await call("POST", go.path, go.body);
    assert.equal(done.screen!.header, "Simulated send");
    assert.equal(fc.simulated.length, before + 1);
    assert.deepEqual(sent, []);
    assert.equal(history.recent(1)[0].kind, "send");
  });

  it("real: needs the password, and a wrong one can be retried", async () => {
    const { call, sent, fc } = await unlockedWorld({ dryRun: false });
    fc.lamports.set(to, 5_000_000);
    const review = await call("POST", "/ui/send/review", { asset: "SOL", to, amount: "0.5" });
    const action = actionOf(review, "CONFIRM SEND") as Extract<Action, { kind: "secret" }>;
    assert.equal(action.kind, "secret");

    assert.match((await call("POST", action.path, { ...action.body })).toast!.text, /Wrong password/);
    assert.match((await call("POST", action.path, { ...action.body, password: "not the password" })).toast!.text, /Wrong password/);
    assert.deepEqual(sent, []);

    const done = await call("POST", action.path, { ...action.body, password: PASSWORD });
    assert.equal(done.screen!.header, "Sent");
    assert.equal(sent.length, 1);
    assert.match((await call("POST", action.path, { ...action.body, password: PASSWORD })).toast!.text, /expired/, "and it works once");
    assert.equal(sent.length, 1);
  });

  it("refuses its own address, more than it holds, and dust to a brand-new wallet", async () => {
    const { call, wallet } = await unlockedWorld();
    assert.match((await call("POST", "/ui/send/address", { asset: "SOL", to: wallet.publicKey.toBase58() })).toast!.text, /own address/);
    assert.match((await call("POST", "/ui/send/review", { asset: "SOL", to, amount: "99999" })).toast!.text, /at most/);
    assert.match((await call("POST", "/ui/send/review", { asset: "SOL", to, amount: "0.0001" })).toast!.text, /brand-new wallet/);
    assert.match((await call("POST", "/ui/send/review", { asset: "SOL", to, amount: "0" })).toast!.text, /Nothing to send/);
  });

  it("sends tokens with their mint's program, creating the other side's account if needed", async () => {
    const { call, m, fc } = await unlockedWorld({}, {}, { holdTokens: BigInt("25000000000000") });
    const assets = await call("GET", "/ui/send");
    assert.equal(assets.screen!.rows.length, 2, "SOL and the token held");
    const review = await call("POST", "/ui/send/review", { asset: m, to, percent: 100 });
    assert.ok(texts(review).some((t) => t.startsWith("Send 25000000")), texts(review).join(" | "));
    const go = postOf(review, "SIMULATE SEND");
    await call("POST", go.path, go.body);
    const tx = fc.simulated.at(-1)!;
    const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58());
    assert.ok(programs.includes("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), "creates the account");
    assert.ok(programs.includes(TOKEN_PROGRAM_ID.toBase58()), "transfers with the token program");
  });

  it("turns typed amounts into exact whole units", () => {
    assert.equal(toRawAmount("1.5", 9).toString(), "1500000000");
    assert.equal(toRawAmount("0,25", 6).toString(), "250000");
    assert.equal(toRawAmount(".1", 2).toString(), "10");
    assert.equal(toRawAmount("0.000000001", 9).toString(), "1");
    assert.equal(toRawAmount("123456789012345678", 9).toString(), "123456789012345678000000000");
    assert.throws(() => toRawAmount("abc", 9), /Enter an amount/);
    assert.equal(fromRawAmount(toRawAmount("1.5", 9), 9), "1.5");
    assert.equal(fromRawAmount(toRawAmount("0.000001", 6), 6), "0.000001");
    assert.equal(fromRawAmount(toRawAmount("2", 9), 9), "2");
    assert.equal(fromRawAmount(toRawAmount("1.23456", 6), 6, 2), "1.23");
  });
});

describe("creating a coin", () => {
  it("shows the coin as it stands, and waits on what it still needs", async () => {
    const wallet = Keypair.generate();
    const { call } = makeGate(memoryStore(encryptKeypair(wallet, PASSWORD, KDF)));
    await call("POST", "/ui/unlock", { password: PASSWORD });
    fs.writeFileSync(path.join(tmp, "images", "shot.png"), "x");
    const card = (r: UiResponse) => r.screen!.rows[0].style as { kind: string; name: string; symbol: string; image?: string; detail?: string };
    const picked = (r: UiResponse) => r.screen!.rows[r.screen!.selected].text;

    const empty = await call("GET", "/ui/launch");
    assert.equal(card(empty).kind, "coinPreview");
    assert.equal(card(empty).image, undefined);
    assert.equal(card(empty).symbol, "$TICKER");
    assert.match(picked(empty), /^Photo/);

    const photo = await call("POST", "/ui/launch/set", { field: "image", value: "shot.png" });
    assert.equal(card(photo).image, "shot.png");
    assert.match(picked(photo), /^Name/);

    const named = await call("POST", "/ui/launch/set", { field: "name", value: "Downtown" });
    assert.equal(card(named).name, "Downtown");
    assert.match(picked(named), /^Ticker/);

    const ticker = await call("POST", "/ui/launch/set", { field: "symbol", value: "dtwn" });
    assert.equal(card(ticker).symbol, "$DTWN");
    assert.equal(picked(ticker), "Review");

    const about = await call("POST", "/ui/launch/set", { field: "description", value: "Next stop" });
    assert.equal(card(about).detail, "Next stop");
  });
});

describe("qr codes", () => {
  it("are square and stable for an address", () => {
    const address = Keypair.generate().publicKey.toBase58();
    const a = qrModules(address);
    assert.deepEqual(a, qrModules(address));
    assert.equal(a.length, 29, "version 3, the smallest that holds an address");
    assert.equal(a[0].slice(0, 7), "1111111", "the finder square in the corner");
  });
});

describe("watchParent", () => {
  it("fires once when the process is gone, and not before", async () => {
    let alive = true;
    let gone = 0;
    watchParent(123, () => gone++, { everyMs: 5, isAlive: () => alive });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(gone, 0);
    alive = false;
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(gone, 1);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(gone, 1);
  });

  it("sees this process as alive and a dead one as gone", async () => {
    const dead = await new Promise<number>((resolve) => {
      const child = require("node:child_process").spawn(process.execPath, ["-e", ""]);
      child.on("exit", () => resolve(child.pid));
    });
    let mine = 0;
    let theirs = 0;
    const stop = watchParent(process.pid, () => mine++, { everyMs: 5 });
    watchParent(dead, () => theirs++, { everyMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    assert.equal(mine, 0);
    assert.equal(theirs, 1);
  });
});
