import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_CONFIG, Config } from "../src/config.js";
import { MetaResolver } from "../src/metadata.js";
import { SolPrice } from "../src/price.js";
import { PumpEngine } from "../src/pump.js";
import { LAUNCH_REFERENCE, RugrApi, RugrCoin } from "../src/rugr.js";
import { History, Watchlist } from "../src/store.js";
import { TokenDirectory } from "../src/tokens.js";
import { Action, PhoneApp, Screen, UiResponse } from "../src/ui.js";
import { FakeConnection, fakeRugrFetch, fakeTokensFetch, pumpInstructions, seedChain, seedSolPrice } from "./fakeChain.js";

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pumpv-test-"));
  fs.mkdirSync(path.join(tmp, "images"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeApp(fc: FakeConnection, wallet: Keypair, overrides: Partial<Config> = {}, extra: Partial<ConstructorParameters<typeof PhoneApp>[0]> = {}) {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides };
  const connection = fc.asConnection();
  return new PhoneApp({
    config,
    connection,
    wallet,
    engine: new PumpEngine(connection, config.slippagePercent),
    api: new RugrApi("https://rugr.test", fakeRugrFetch()),
    meta: new MetaResolver(connection),
    price: new SolPrice(connection),
    history: new History(path.join(tmp, `history-${Math.random()}.jsonl`)),
    watchlist: new Watchlist(path.join(tmp, `watch-${Math.random()}.json`)),
    imagesDir: path.join(tmp, "images"),
    tokens: new TokenDirectory(fakeTokensFetch()),
    ...extra,
  });
}

async function call(app: PhoneApp, method: string, p: string, body: Record<string, unknown> = {}): Promise<UiResponse> {
  const res = await app.handle(method, new URL(p, "http://127.0.0.1"), body);
  assert.ok(res, `route ${method} ${p} exists`);
  return res!;
}

function rowWith(s: Screen, prefix: string) {
  const r = s.rows.find((x) => x.text.startsWith(prefix));
  assert.ok(r, `row starting "${prefix}" in [${s.rows.map((x) => x.text).join(" | ")}]`);
  return r!;
}

function postBody(a: Action | undefined): Record<string, unknown> {
  assert.ok(a && a.kind === "post");
  return (a as Extract<Action, { kind: "post" }>).body ?? {};
}

const fakeMint = () => Keypair.generate().publicKey.toBase58();

const rugrCoin = (mint: string, extra: Partial<RugrCoin> = {}): RugrCoin => ({
  mint,
  name: `Coin ${mint.slice(0, 4)}`,
  symbol: mint.slice(0, 4).toUpperCase(),
  createdMs: Date.now() - 30_000,
  marketCapUsd: 12_340,
  changePct: 5.5,
  volumeUsd: 1_000,
  traders: 20,
  holders: 40,
  progressPct: 22,
  ...extra,
});

describe("Trending and New: only coins launched on RUGR", () => {
  function listApp(coins: RugrCoin[], opts: Parameters<typeof fakeRugrFetch>[1] = {}) {
    const fc = new FakeConnection();
    return makeApp(fc, Keypair.generate(), {}, { api: new RugrApi("https://rugr.test", fakeRugrFetch(() => coins, opts)) });
  }

  it("show RUGR's coins with real numbers in dollars, each opening its page", async () => {
    const hot = fakeMint();
    const s = (await call(listApp([rugrCoin(hot)]), "GET", "/ui/list?kind=trending")).screen!;
    const style = s.rows[0].style as Record<string, any>;
    assert.equal(style.kind, "coin");
    assert.equal(style.mint, hot);
    assert.equal(style.name, `Coin ${hot.slice(0, 4)}`);
    assert.equal(style.marketCap, "$12.34K");
    assert.equal(style.change, "+5.50%");
    assert.equal(style.up, true);
    assert.equal(style.progressPct, 22);
    assert.equal(style.detail, "Vol $1K · 20 traders");
    assert.deepEqual(s.rows[0].action, { kind: "open", path: `/ui/token?mint=${hot}` });
    assert.ok(s.rows.some((r) => r.text === "Search any token"), "any other token is a search away");
  });

  it("New says how old a coin is, newest first", async () => {
    const older = rugrCoin(fakeMint(), { createdMs: Date.now() - 300_000 });
    const newer = rugrCoin(fakeMint(), { createdMs: Date.now() - 20_000 });
    const s = (await call(listApp([older, newer]), "GET", "/ui/list?kind=new")).screen!;
    assert.deepEqual(s.rows.slice(0, 2).map((r) => (r.style as { mint: string }).mint), [newer.mint, older.mint]);
    assert.match((s.rows[0].style as { detail: string }).detail, /^20s · /);
    assert.equal(s.refreshMs, 10_000);
  });

  it("a graduated coin says so instead of showing a curve", async () => {
    const s = (await call(listApp([rugrCoin(fakeMint(), { graduated: true, progressPct: undefined })]), "GET", "/ui/list?kind=trending")).screen!;
    const style = s.rows[0].style as { graduated: boolean; progressPct?: number };
    assert.equal(style.graduated, true);
    assert.equal(style.progressPct, undefined);
  });

  it("invite the first launch while there are none yet", async () => {
    const s = (await call(listApp([]), "GET", "/ui/list?kind=trending")).screen!;
    assert.equal(s.rows[0].text, "No coins launched on RUGR yet");
    assert.deepEqual(rowWith(s, "Create Coin").action, { kind: "open", path: "/ui/launch" });
    assert.ok(s.rows.some((r) => r.action?.kind === "input"), "and searching still works");
  });

  it("say so when RUGR can't be reached, and keep a way forward", async () => {
    const s = (await call(listApp([], { down: true }), "GET", "/ui/list?kind=new")).screen!;
    assert.equal(s.rows[0].text, "Can't reach RUGR right now");
    assert.equal(s.refreshMs, 10_000);
    assert.ok(s.rows.some((r) => r.action?.kind === "refresh"));
    assert.ok(s.rows.some((r) => r.action?.kind === "input"));
  });
});

describe("RugrApi", () => {
  it("keeps the last good list through a short outage", async () => {
    let now = 1_000_000;
    let down = false;
    let calls = 0;
    const api = new RugrApi("https://rugr.test", (async (url: string) => {
      calls++;
      if (down) throw new Error("offline");
      return fakeRugrFetch(() => [rugrCoin("abcd")])(url);
    }) as unknown as typeof fetch, () => now);
    assert.equal((await api.coins("trending"))?.length, 1);
    await api.coins("trending");
    assert.equal(calls, 1, "a fresh list isn't asked for again");
    down = true;
    now += 20_000;
    assert.equal((await api.coins("trending"))?.length, 1, "the last good list");
    assert.equal(await new RugrApi("https://rugr.test", fakeRugrFetch(() => [], { down: true })).coins("new"), null);
  });

  it("an upload sends the picture and details, and a failure says nothing was sent", async () => {
    const uploads: Record<string, unknown>[] = [];
    const file = path.join(tmp, "images", "up.png");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const uri = await new RugrApi("https://rugr.test", fakeRugrFetch(() => [], { uploads })).upload({ image: { path: file, mime: "image/png", name: "up.png" }, name: "Los Santos Coin", symbol: "LSC", description: "" });
    assert.ok(uri.startsWith("https://rugr.test/m/"));
    assert.equal(uploads[0].symbol, "LSC");
    assert.equal(uploads[0].image, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
    const down = new RugrApi("https://rugr.test", fakeRugrFetch(() => [], { down: true }));
    await assert.rejects(down.upload({ image: { path: file, mime: "image/png", name: "up.png" }, name: "X", symbol: "X", description: "" }), /Nothing was sent/);
  });
});

describe("TokenDirectory", () => {
  it("backs off when told it's asking too much, and keeps what it knew", async () => {
    let now = 1_000_000;
    let calls = 0;
    let status = 200;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify([{ id: "abcd", symbol: "ABCD" }]), { status });
    }) as unknown as typeof fetch;
    const tokens = new TokenDirectory(fetchImpl, () => now);
    assert.equal((await tokens.lookup(["abcd"])).get("abcd")?.symbol, "ABCD");
    await tokens.lookup(["abcd"]);
    assert.equal(calls, 1, "fresh information isn't asked for again");
    status = 429;
    now += 61_000;
    assert.equal((await tokens.lookup(["abcd"])).get("abcd")?.symbol, "ABCD", "what it knew");
    await tokens.lookup(["other"]);
    assert.equal(calls, 2, "everything waits after being told to slow down");
  });

  it("gives nothing rather than breaking when it can't be reached", async () => {
    const tokens = new TokenDirectory((async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    assert.equal((await tokens.lookup(["x"])).size, 0);
  });
});

describe("phone app against a fake chain", () => {
  it("shows a token page priced from the bonding curve", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey);
    const res = await call(makeApp(fc, wallet), "GET", `/ui/token?mint=${mint.toBase58()}`);
    const s = res.screen!;
    assert.match(rowWith(s, "MC ").text, /^MC [\d.]+ SOL curve \d+(\.\d)?%$/);
    assert.equal(rowWith(s, "You hold").text, "You hold 0");
    assert.ok(rowWith(s, "Buy 0.1 SOL").enabled);
    assert.ok(!s.rows.some((r) => r.text.startsWith("Sell")), "no sell rows without a balance");
    assert.equal(s.rows[s.selected].text, "Buy 0.01 SOL", "highlight starts on the first action");
  });

  it("buy: confirm screen starts on Cancel and the tx never spends more than chosen", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey);
    const app = makeApp(fc, wallet, { dryRun: true, slippagePercent: 10 });
    const confirm = await call(app, "POST", "/ui/quote/buy", { mint: mint.toBase58(), sol: 0.1 });
    assert.equal(confirm.nav, "push");
    const s = confirm.screen!;
    assert.equal(s.path, "", "confirm screens are never re-fetched");
    assert.equal(s.rows[s.selected].text, "Cancel");
    const exec = s.rows.find((r) => r.text === "SIMULATE BUY");
    assert.ok(exec);

    const result = await call(app, "POST", "/ui/execute", postBody(exec!.action));
    assert.equal(result.nav, "replace");
    assert.equal(result.screen!.header, "Simulated buy");
    assert.equal(result.toast?.level, "success");

    assert.equal(fc.simulated.length, 1);
    const ixs = pumpInstructions(fc.simulated[0]);
    const buy = ixs.find((i) => i.name === "buy");
    assert.ok(buy, `buy ix in ${ixs.map((i) => i.name)}`);
    assert.ok(BigInt(buy!.data.maxSolCost.toString()) <= 100_000_000n, `maxSolCost ${buy!.data.maxSolCost} <= 0.1 SOL`);
    assert.ok(BigInt(buy!.data.maxSolCost.toString()) > 99_000_000n, "and not needlessly low");
    assert.ok(BigInt(buy!.data.amount.toString()) > 0n);

    // A quote works once.
    const again = await call(app, "POST", "/ui/execute", postBody(exec!.action));
    assert.equal(again.toast?.level, "error");
    assert.equal(fc.simulated.length, 1);
  });

  it("buy: refuses amounts over maxSolPerTrade and when the wallet is short", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey, { userLamports: 50_000_000 });
    const app = makeApp(fc, wallet, { maxSolPerTrade: 0.5 });
    const tooBig = await call(app, "POST", "/ui/quote/buy", { mint: mint.toBase58(), sol: "0.6" });
    assert.match(tooBig.toast!.text, /Max per trade/);
    const short = await call(app, "POST", "/ui/quote/buy", { mint: mint.toBase58(), sol: "0.1" });
    assert.match(short.toast!.text, /Not enough SOL/);
    const junk = await call(app, "POST", "/ui/quote/buy", { mint: mint.toBase58(), sol: "lots" });
    assert.match(junk.toast!.text, /Enter an amount/);
  });

  it("sell: on-chain minimum equals the minimum shown", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey, { holdTokens: BigInt("10000000000000") }); // 10M tokens
    const app = makeApp(fc, wallet, { slippagePercent: 7.5 });
    const page = (await call(app, "GET", `/ui/token?mint=${mint.toBase58()}`)).screen!;
    assert.match(rowWith(page, "You hold").text, /^You hold 10M = [\d.]+ SOL$/);
    const sell = rowWith(page, "Sell 50%");
    const confirm = (await call(app, "POST", "/ui/quote/sell", postBody(sell.action))).screen!;
    const minRow = rowWith(confirm, "At least ");
    const exec = confirm.rows.find((r) => r.text === "SIMULATE SELL")!;
    await call(app, "POST", "/ui/execute", postBody(exec.action));
    const ix = pumpInstructions(fc.simulated[0]).find((i) => i.name === "sell")!;
    assert.equal(ix.data.amount.toString(), "5000000000000");
    const shownMin = Number(/At least ([\d.]+) SOL/.exec(minRow.text)![1]);
    const chainMin = Number(ix.data.minSolOutput.toString()) / 1e9;
    assert.ok(Math.abs(chainMin - shownMin) / shownMin < 0.001, `chain min ${chainMin} ~ shown ${shownMin}`);
  });

  it("shows dollars when the SOL price is known, but still trades in SOL", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey, { holdTokens: BigInt("10000000000000") });
    seedSolPrice(fc, 100);
    const app = makeApp(fc, wallet);
    const m = mint.toBase58();
    const page = (await call(app, "GET", `/ui/token?mint=${m}`)).screen!;
    assert.match(rowWith(page, "MC ").text, /^MC \$5\.72K curve \d+(\.\d)?%$/);
    assert.equal(rowWith(page, "Price ").text, "Price $0.00000572");
    assert.match(rowWith(page, "You hold").text, /^You hold 10M = \$\d+/);
    const hero = page.rows[0].style;
    assert.ok(hero?.kind === "coinHero" && hero.marketCap === "$5.72K");
    const curve = page.rows[1].style;
    assert.ok(curve?.kind === "progress" && curve.pct > 0 && curve.pct < 100);
    assert.ok(rowWith(page, "Buy 0.1 SOL").style?.kind === "button");

    const confirm = (await call(app, "POST", "/ui/quote/buy", { mint: m, sol: 0.1 })).screen!;
    assert.equal(rowWith(confirm, "Spend up to").text, "Spend up to 0.1 SOL ($10)", "the amount is SOL; dollars are a guide");
    const home = (await call(app, "GET", "/ui/home")).screen!;
    assert.deepEqual(home.rows[0].style, { kind: "wallet", sol: "2 SOL", usd: "$200" });
  });

  it("launch: needs name, ticker and image; then a create with RUGR's reference, and the first buy after", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    await seedChain(fc, wallet.publicKey);
    fs.writeFileSync(path.join(tmp, "images", "shot-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const app = makeApp(fc, wallet, { launchBuyPresetsSol: [0, 0.05] });
    const missing = await call(app, "POST", "/ui/launch/review");
    assert.match(missing.toast!.text, /name/i);
    await call(app, "POST", "/ui/launch/set", { field: "name", value: "Los Santos Coin" });
    const badTicker = await call(app, "POST", "/ui/launch/set", { field: "symbol", value: "WAY TOO LONG TICKER" });
    assert.equal(badTicker.toast?.level, "error");
    await call(app, "POST", "/ui/launch/set", { field: "symbol", value: "$lsc" });
    const escape = await call(app, "POST", "/ui/launch/set", { field: "image", value: "../keystore.json" });
    assert.equal(escape.toast?.level, "error", "images outside the folder are refused");
    await call(app, "POST", "/ui/launch/set", { field: "image", value: "shot-1.png" });
    const cycled = await call(app, "POST", "/ui/launch/next-buy");
    assert.ok(cycled.screen!.rows.some((r) => r.text === "First buy: 0.05 SOL"));

    const confirm = (await call(app, "POST", "/ui/launch/review")).screen!;
    assert.ok(confirm.rows.some((r) => r.text === "Create $LSC"));
    assert.ok(confirm.rows.some((r) => r.text === "Bought the moment the coin exists"));
    const exec = confirm.rows.find((r) => r.text === "SIMULATE CREATE")!;
    const result = await call(app, "POST", "/ui/execute", postBody(exec.action));
    assert.equal(result.screen!.header, "Simulated create");
    assert.ok(result.screen!.rows.some((r) => r.text === "First buy runs after the create"));
    // Create and buy together are too big for one transaction, so the create goes alone.
    const names = pumpInstructions(fc.simulated[0]).map((i) => i.name);
    assert.deepEqual(names.filter((n) => n === "createV2" || n === "buy"), ["createV2"]);
    assert.ok(fc.simulated[0].message.staticAccountKeys.some((k) => k.equals(LAUNCH_REFERENCE)), "the reference that lists it on RUGR");
    const create = pumpInstructions(fc.simulated[0]).find((i) => i.name === "createV2")!;
    assert.equal(create.data.name, "Los Santos Coin");
    assert.equal(create.data.symbol, "LSC");
    // Signed by the wallet and the new mint.
    assert.equal(fc.simulated[0].signatures.length, 2);
  });

  it("live mode sends through the injected sender and records history", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey);
    let sent = 0;
    const app = makeApp(fc, wallet, { dryRun: false }, {
      send: async () => {
        sent++;
        return "5ig".padEnd(88, "x");
      },
    });
    const confirm = (await call(app, "POST", "/ui/quote/buy", { mint: mint.toBase58(), sol: 0.05 })).screen!;
    const exec = confirm.rows.find((r) => r.text === "CONFIRM BUY")!;
    const result = await call(app, "POST", "/ui/execute", postBody(exec.action));
    assert.equal(result.screen!.header, "Bought");
    assert.equal(sent, 1);
    assert.equal(fc.simulated.length, 0, "live mode does not call simulate itself (preflight does)");
    const hist = (await call(app, "GET", "/ui/history")).screen!;
    assert.match(hist.rows[0].text, /^BUY .* 0\.05$/);
  });

  it("turns failures into readable toasts", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey);
    fc.simulateError = { InstructionError: [2, { Custom: 6002 }] };
    const app = makeApp(fc, wallet);
    const confirm = (await call(app, "POST", "/ui/quote/buy", { mint: mint.toBase58(), sol: 0.01 })).screen!;
    const exec = confirm.rows.find((r) => r.text === "SIMULATE BUY")!;
    const res = await call(app, "POST", "/ui/execute", postBody(exec.action));
    assert.equal(res.nav, "back");
    assert.equal(res.toast?.level, "error");
    const notPump = await call(app, "GET", `/ui/token?mint=${Keypair.generate().publicKey.toBase58()}`);
    assert.match(notPump.toast!.text, /No token exists/);
    const bad = await call(app, "POST", "/ui/search", { mint: "not-an-address" });
    assert.match(bad.toast!.text, /not a valid/);
  });

  it("never buys a Mayhem coin, even by address", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey, { mayhem: true });
    const app = makeApp(fc, wallet);
    const m = mint.toBase58();
    const page = (await call(app, "GET", `/ui/token?mint=${m}`)).screen!;
    assert.ok(page.rows.some((r) => r.text.startsWith("MAYHEM")));
    assert.ok(!page.rows.some((r) => r.text.startsWith("Buy")), "no buy rows");

    const buy = await call(app, "POST", "/ui/quote/buy", { mint: m, sol: 0.01 });
    assert.equal(buy.toast?.level, "error");
    assert.match(buy.toast!.text, /regular coins/);
    assert.equal(buy.screen, undefined, "no confirm screen");
  });

  it("can still sell a Mayhem coin the wallet holds", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey, { mayhem: true, holdTokens: BigInt("10000000000000") });
    const app = makeApp(fc, wallet);
    const page = (await call(app, "GET", `/ui/token?mint=${mint.toBase58()}`)).screen!;
    const sell = rowWith(page, "Sell 50%");
    assert.equal(page.rows[page.selected].text, "Sell 25%", "the highlight starts on the first action");
    const confirm = (await call(app, "POST", "/ui/quote/sell", postBody(sell.action))).screen!;
    assert.ok(confirm.rows.some((r) => r.text === "SIMULATE SELL"));
  });

  it("values a holding at what the curve can pay, and won't quote a sale it can't", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey, { mayhem: true, holdTokens: BigInt("100000000000000"), realQuoteLamports: 4_444_444 });
    const app = makeApp(fc, wallet);
    const m = mint.toBase58();
    const page = (await call(app, "GET", `/ui/token?mint=${m}`)).screen!;
    assert.match(rowWith(page, "You hold").text, /= 0\.0044 SOL$/);

    const sell = await call(app, "POST", "/ui/quote/sell", { mint: m, percent: 100 });
    assert.equal(sell.toast?.level, "error");
    assert.match(sell.toast!.text, /curve only holds 0\.004444444 SOL/);
    assert.equal(sell.screen, undefined, "no confirm screen for a sale that can't happen");

    const coin = (await call(app, "GET", "/ui/wallet")).screen!.rows.find((r) => r.style?.kind === "asset" && r.style.mint === m)!;
    assert.ok(coin.style?.kind === "asset" && coin.style.value === "$0.43", "worth what the curve can pay, at SOL's $95.82");
  });

  it("a coin that graduated away from PumpSwap still has a page, which trades it through Swap", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey, { graduatedAway: true });
    const m = mint.toBase58();
    const tokens = new TokenDirectory(fakeTokensFetch({ [m]: { symbol: "OLD", name: "Old Coin", usdPrice: 0.5, mcap: 500000, holderCount: 1200, stats24h: { priceChange: 12, buyVolume: 1000, sellVolume: 500 } } }));
    const s = (await call(makeApp(fc, wallet, {}, { tokens }), "GET", `/ui/token?mint=${m}`)).screen!;
    assert.deepEqual(rowWith(s, "Swap OLD").action, { kind: "tab", path: `/ui/swap?mint=${m}` });
    assert.equal(rowWith(s, "24h change").text, "24h change +12.00%");
    assert.equal(rowWith(s, "Holders").text, "Holders 1.2K");
    assert.ok(!s.rows.some((r) => r.text.startsWith("Buy")), "no pump.fun buy buttons");
  });

  it("a coin's page adds its real market numbers", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey);
    const m = mint.toBase58();
    const tokens = new TokenDirectory(fakeTokensFetch({ [m]: { usdPrice: 0.5, holderCount: 900, liquidity: 25000, stats24h: { priceChange: -8.5, buyVolume: 3000, sellVolume: 1000 } } }));
    const s = (await call(makeApp(fc, wallet, {}, { tokens }), "GET", `/ui/token?mint=${m}`)).screen!;
    assert.equal(rowWith(s, "24h change").text, "24h change -8.50%");
    assert.equal(rowWith(s, "24h volume").text, "24h volume $4K");
    assert.equal(rowWith(s, "Liquidity").text, "Liquidity $25K");
    assert.equal(rowWith(s, "Holders").text, "Holders 900");
    assert.ok(rowWith(s, "Buy 0.01 SOL").enabled, "still trades as a pump.fun coin");
  });

  it("the wallet lists holdings with their value and links to them", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    const { mint } = await seedChain(fc, wallet.publicKey, { holdTokens: BigInt("10000000000000") });
    const m = mint.toBase58();
    const s = (await call(makeApp(fc, wallet), "GET", "/ui/wallet")).screen!;
    assert.equal(s.tab, true);
    const total = s.rows[0].style;
    assert.ok(total?.kind === "balance" && total.value.startsWith("$"));
    assert.deepEqual(s.rows.filter((r) => r.style?.kind === "action").map((r) => r.text), ["Send", "Swap", "Receive", "Settings"]);
    assert.equal(s.rows[s.selected].text, "Send", "the highlight starts on the first button, not the address");
    const coin = s.rows.find((r) => r.style?.kind === "asset" && r.style.mint === m)!;
    assert.deepEqual(coin.action, { kind: "open", path: `/ui/token?mint=${m}` });
    const sol = s.rows.find((r) => r.style?.kind === "asset" && r.style.symbol === "SOL")!;
    assert.deepEqual(sol.action?.kind, "tab", "SOL has no coin page, so it opens in Swap");
  });

  it("the wallet adds up real prices and 24-hour changes, and says nothing when it has none", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    await seedChain(fc, wallet.publicKey, { userLamports: 2_000_000_000 });
    const priced = (await call(makeApp(fc, wallet), "GET", "/ui/wallet")).screen!.rows[0].style;
    assert.ok(priced?.kind === "balance");
    assert.equal(priced.value, "$191.64", "2 SOL at $95.82");
    assert.equal(priced.detail, "+4.76%");
    assert.equal(priced.change, "+$8.71", "what that is in dollars");
    assert.equal(priced.up, true);

    const unpriced = makeApp(fc, wallet, {}, { tokens: new TokenDirectory(fakeTokensFetch({})) });
    const s = (await call(unpriced, "GET", "/ui/wallet")).screen!;
    assert.ok(s.rows[0].style?.kind === "balance" && s.rows[0].style.change === undefined, "no made-up change");
  });

  it("the wallet still opens when the token list can't be reached", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    await seedChain(fc, wallet.publicKey);
    seedSolPrice(fc, 100);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const s = (await call(makeApp(fc, wallet, {}, { tokens: new TokenDirectory(down) }), "GET", "/ui/wallet")).screen!;
    assert.ok(s.rows[0].style?.kind === "balance" && s.rows[0].style.value.startsWith("$"), "priced from the chain instead");
    assert.ok(s.rows.some((r) => r.style?.kind === "asset" && r.style.symbol === "SOL"));
  });

  it("the bottom tabs are the four main screens, and home has no doubled-up rows", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    await seedChain(fc, wallet.publicKey);
    const app = makeApp(fc, wallet);
    for (const p of ["/ui/home", "/ui/swap", "/ui/wallet", "/ui/history"]) {
      const s = (await call(app, "GET", p)).screen!;
      assert.equal(s.tab, true, p);
      assert.equal(s.path, p);
    }
    const home = (await call(app, "GET", "/ui/home")).screen!;
    const names = home.rows.map((r) => r.text);
    for (const gone of ["Launchpad", "Positions", "Swap", "Trades"]) assert.ok(!names.includes(gone), gone);
    assert.deepEqual(home.rows[0].action, { kind: "tab", path: "/ui/wallet" });
    assert.equal((await call(app, "GET", "/ui/watchlist")).screen!.tab, undefined, "a screen inside a tab is not a tab");
    assert.equal((await call(app, "GET", "/ui/list?kind=launchpad")).toast?.level, "error", "launchpad is gone");
  });

  it("a Practice create uploads nothing; a real one uploads, sends, lists itself, then tries the first buy", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    await seedChain(fc, wallet.publicKey);
    fs.writeFileSync(path.join(tmp, "images", "shot-2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const uploads: Record<string, unknown>[] = [];
    const registered: string[] = [];
    const sent: number[] = [];
    const launch = async (dryRun: boolean) => {
      const app = makeApp(fc, wallet, { launchBuyPresetsSol: [0.05], dryRun }, {
        api: new RugrApi("https://rugr.test", fakeRugrFetch(() => [], { uploads, registered })),
        send: async () => {
          sent.push(1);
          return "5ig".padEnd(88, String(sent.length));
        },
      });
      await call(app, "POST", "/ui/launch/set", { field: "name", value: "Coin" });
      await call(app, "POST", "/ui/launch/set", { field: "symbol", value: "COIN" });
      await call(app, "POST", "/ui/launch/set", { field: "image", value: "shot-2.png" });
      const confirm = (await call(app, "POST", "/ui/launch/review")).screen!;
      const exec = confirm.rows.find((r) => r.action?.kind === "post" && /CREATE/.test(r.text))!;
      return (await call(app, "POST", "/ui/execute", postBody(exec.action))).screen!;
    };
    await launch(true);
    assert.equal(uploads.length, 0, "Practice keeps everything on the PC");

    const real = await launch(false);
    assert.equal(real.header, "Created");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].name, "Coin");
    assert.equal(sent.length, 1, "the create went out");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(registered.length, 1, "and the server was told about it");
    // The fake chain doesn't run the create, so the coin isn't there to buy: the create still stands.
    assert.ok(real.rows.some((r) => r.text.startsWith("First buy didn't go through")));
    assert.ok(real.rows.some((r) => r.text === "Open coin page"));
  });

  it("home screen flags dry-run mode", async () => {
    const fc = new FakeConnection();
    const wallet = Keypair.generate();
    await seedChain(fc, wallet.publicKey);
    const s = (await call(makeApp(fc, wallet, { dryRun: true }), "GET", "/ui/home")).screen!;
    assert.equal(s.rows[0].text, "Wallet 2 SOL");
    assert.ok(s.rows.some((r) => r.text.startsWith("PRACTICE")));
  });
});
