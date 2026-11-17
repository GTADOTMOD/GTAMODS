import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Connection } from "@solana/web3.js";
import { CoinBoard } from "../src/coins.js";
import { LAUNCH_REFERENCE, ServerConfig } from "../src/config.js";
import { createApp } from "../src/index.js";
import { ClientError, Created, acceptUpload, createIn, imageKind, listIfRugr } from "../src/launches.js";
import { RateLimiter, clientKey } from "../src/limits.js";
import { RpcRelay, RpcRequestError, checkCalls } from "../src/rpc.js";
import { Store } from "../src/store.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PUBLIC_URL = "https://rugr.test";
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "test", "fixtures", "create.json"), "utf8")) as { logs: string[]; created: Created };
const offline = new Connection("http://127.0.0.1:9", "confirmed");

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rugr-server-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const freshStore = () => new Store(fs.mkdtempSync(path.join(tmp, "store-")));

describe("the RPC", () => {
  it("passes on only the calls the app makes, in batches of up to 20", () => {
    assert.equal(checkCalls({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [] }), 1);
    assert.equal(checkCalls(Array.from({ length: 20 }, (_, i) => ({ id: i, method: "getAccountInfo" }))), 20);
    assert.throws(() => checkCalls({ method: "getProgramAccounts" }), (e: unknown) => e instanceof RpcRequestError && e.status === 403);
    assert.throws(() => checkCalls({ method: "requestAirdrop" }), RpcRequestError);
    assert.throws(() => checkCalls(Array.from({ length: 21 }, () => ({ method: "getSlot" }))), RpcRequestError);
    assert.throws(() => checkCalls([]), RpcRequestError);
  });

  it("answers from the private RPC, and sends a transaction out the public way too", async () => {
    const seen: string[] = [];
    const fake = async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ result: url }), { status: 200 });
    };
    const relay = new RpcRelay({ rpcUrl: "https://private", publicRpcUrl: "https://public" }, () => undefined, fake as never);
    const out = await relay.relay({ id: 1, method: "getBalance" });
    assert.equal(JSON.parse(out.text).result, "https://private");
    assert.deepEqual(seen, ["https://private"]);
    await relay.relay({ id: 1, method: "sendTransaction", params: ["tx"] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen.slice(1), ["https://private", "https://public"]);
  });

  it("falls back to the public RPC when the private one is busy or down", async () => {
    let privateStatus = 429;
    const fake = async (url: string) => {
      if (url === "https://private") {
        if (privateStatus === 0) throw new Error("down");
        return new Response("{}", { status: privateStatus });
      }
      return new Response(JSON.stringify({ result: "public" }), { status: 200 });
    };
    const relay = new RpcRelay({ rpcUrl: "https://private", publicRpcUrl: "https://public" }, () => undefined, fake as never);
    assert.equal(JSON.parse((await relay.relay({ method: "getSlot" })).text).result, "public");
    privateStatus = 0;
    assert.equal(JSON.parse((await relay.relay({ method: "getSlot" })).text).result, "public");
    privateStatus = 503;
    assert.equal(JSON.parse((await relay.relay({ method: "getSlot" })).text).result, "public");
  });
});

describe("limits", () => {
  it("allow a burst, then refill steadily", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 4, () => now);
    assert.ok(limiter.take("a", 4));
    assert.ok(!limiter.take("a"));
    assert.ok(limiter.take("b"), "each player has their own");
    now += 500;
    assert.ok(limiter.take("a"));
    assert.ok(!limiter.take("a"));
  });

  it("know the player behind Cloudflare and Render's proxy, and can't be fooled by a made-up header", () => {
    assert.equal(clientKey({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9" }, "10.0.0.1"), "1.1.1.1");
    assert.equal(clientKey({ "x-forwarded-for": "6.6.6.6, 2.2.2.2" }, "10.0.0.1"), "2.2.2.2");
    assert.equal(clientKey({}, "10.0.0.1"), "10.0.0.1");
  });
});

describe("uploads", () => {
  it("keep a coin's picture and pump.fun-style metadata, and link to them", () => {
    const store = freshStore();
    const out = acceptUpload(store, PUBLIC_URL, { name: "  Los  Santos Coin ", symbol: "$lsc", description: "Shot\non a corner", image: PNG.toString("base64") });
    assert.match(out.uri, /^https:\/\/rugr\.test\/m\/[0-9a-f]{40}\.json$/);
    assert.match(out.image, /^https:\/\/rugr\.test\/i\/[0-9a-f]{64}\.png$/);
    const meta = store.readMetadata(out.uri.split("/").pop()!.replace(".json", ""))!;
    assert.deepEqual(meta, { name: "Los Santos Coin", symbol: "LSC", description: "Shot on a corner", image: out.image, showName: true, createdOn: "https://gtamod.onrender.com" });
    assert.equal(acceptUpload(store, PUBLIC_URL, { name: "Los Santos Coin", symbol: "LSC", description: "Shot on a corner", image: PNG.toString("base64") }).uri, out.uri, "the same upload is the same file");
  });

  it("refuse what the phone would refuse, and anything that isn't a picture", () => {
    const store = freshStore();
    const ok = { name: "Coin", symbol: "COIN", description: "", image: PNG.toString("base64") };
    for (const bad of [
      { ...ok, name: "" },
      { ...ok, name: "x".repeat(33) },
      { ...ok, symbol: "WAYTOOLONGTICKER" },
      { ...ok, symbol: "NO-DASH" },
      { ...ok, description: "x".repeat(301) },
      { ...ok, image: Buffer.from("not a picture").toString("base64") },
      { ...ok, image: undefined },
    ]) {
      assert.throws(() => acceptUpload(store, PUBLIC_URL, bad), ClientError, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
    assert.equal(imageKind(Buffer.concat([Buffer.from("RIFF0000WEBP"), Buffer.alloc(4)])), "webp");
  });
});

describe("launches", () => {
  it("read a real pump.fun create from its logs", () => {
    const created = createIn(offline, FIXTURE.logs)!;
    assert.equal(created.mint, FIXTURE.created.mint);
    assert.equal(created.symbol, FIXTURE.created.symbol);
    assert.ok(created.uri.startsWith("http"));
    assert.ok(created.createdMs > Date.parse("2026-01-01"));
  });

  it("list only RUGR's: the reference, no Mayhem, and metadata from this server", () => {
    const store = freshStore();
    const { uri } = acceptUpload(store, PUBLIC_URL, { name: "Coin", symbol: "COIN", description: "", image: PNG.toString("base64") });
    const base: Created = { mint: "MintAddress1111111111111111111111111111111", name: "Coin", symbol: "COIN", uri, creator: "Creator", createdMs: 1_000, mayhem: false, fromRugr: true };
    assert.equal(listIfRugr(store, PUBLIC_URL, { ...base, fromRugr: false }, "sig"), "not launched from RUGR");
    assert.equal(listIfRugr(store, PUBLIC_URL, { ...base, mayhem: true }, "sig"), "a Mayhem coin");
    assert.equal(listIfRugr(store, PUBLIC_URL, { ...base, uri: "https://ipfs.io/ipfs/abc" }, "sig"), "its metadata isn't RUGR's");
    assert.equal(listIfRugr(store, PUBLIC_URL, { ...base, uri: `${PUBLIC_URL}/m/${"0".repeat(40)}.json` }, "sig"), "its metadata isn't RUGR's");
    const listed = listIfRugr(store, PUBLIC_URL, base, "sig");
    assert.ok(typeof listed !== "string" && listed.image?.startsWith(`${PUBLIC_URL}/i/`));
    assert.equal(new Store(path.dirname(store.meta)).allCoins().length, 1, "kept on disk");
    assert.equal(typeof listIfRugr(store, PUBLIC_URL, base, "sig"), "object", "listing twice is harmless");
  });

  it("tidy away uploads that never became a coin, and keep everything a coin links to", () => {
    const store = freshStore();
    const used = acceptUpload(store, PUBLIC_URL, { name: "Used", symbol: "USED", description: "", image: PNG.toString("base64") });
    acceptUpload(store, PUBLIC_URL, { name: "Unused", symbol: "NOPE", description: "", image: Buffer.concat([PNG, Buffer.from([0])]).toString("base64") });
    listIfRugr(store, PUBLIC_URL, { mint: "M", name: "Used", symbol: "USED", uri: used.uri, creator: "C", createdMs: 1, mayhem: false, fromRugr: true }, "sig");
    assert.equal(store.sweep(Date.now()), 0, "nothing is that old yet");
    assert.equal(store.sweep(Date.now() + 2 * 24 * 60 * 60_000), 2, "the unused metadata and its picture");
    assert.ok(store.fileFor("meta", used.uri.split("/").pop()!));
    assert.ok(store.fileFor("images", used.image.split("/").pop()!));
  });
});

describe("Trending and New", () => {
  it("rank RUGR's coins by traders, then volume, and New by age", async () => {
    const store = freshStore();
    const coin = (mint: string, createdMs: number) => store.addCoin({ mint, name: mint, symbol: mint.toUpperCase(), uri: "u", creator: "c", createdMs, signature: mint });
    coin("quiet", 3_000);
    coin("busy", 1_000);
    coin("loud", 2_000);
    const jupiter = async () =>
      new Response(JSON.stringify([
        { id: "So11111111111111111111111111111111111111112", usdPrice: 150 },
        { id: "busy", mcap: 50_000, holderCount: 90, stats5m: { numTraders: 30, buyVolume: 900, sellVolume: 100, priceChange: 12 } },
        { id: "loud", mcap: 20_000, stats5m: { numTraders: 30, buyVolume: 5000, sellVolume: 0, priceChange: -4 } },
      ]), { status: 200 });
    const failingChain = { getMultipleAccountsInfo: async () => { throw new Error("offline"); }, getAccountInfo: async () => { throw new Error("offline"); } };
    const board = new CoinBoard(failingChain as never, store, "mainnet", "", () => undefined, jupiter as never, async () => undefined);
    await board.refresh();
    assert.deepEqual(board.list("trending").map((c) => c.mint), ["loud", "busy", "quiet"]);
    assert.deepEqual(board.list("new").map((c) => c.mint), ["quiet", "loud", "busy"]);
    const busy = board.list("trending")[1];
    assert.equal(busy.marketCapUsd, 50_000);
    assert.equal(busy.volumeUsd, 1_000);
    assert.equal(busy.traders, 30);
    assert.equal(busy.holders, 90);
  });
});

describe("the server", () => {
  let server: http.Server;
  let base: string;
  before(async () => {
    const cfg: ServerConfig = { port: 0, publicUrl: PUBLIC_URL, network: "mainnet", rpcUrl: "http://127.0.0.1:9", publicRpcUrl: "http://127.0.0.1:9", dataDir: path.join(tmp, "app"), jupiterKey: "" };
    server = createApp(cfg, () => undefined).server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("says what it is, with the reference launches use", async () => {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.reference, LAUNCH_REFERENCE.toBase58());
    assert.equal(health.reference, "DTd9oBwtsdTK7q2UoN4ejGYe7CuuEyFyaeSk1E2D5RqW", "the same one the companion uses");
  });

  it("takes an upload and serves its metadata and picture", async () => {
    const res = await fetch(`${base}/launch/upload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Coin", symbol: "COIN", image: PNG.toString("base64") }) });
    assert.equal(res.status, 200);
    const { uri, image } = await res.json();
    const meta = await fetch(uri.replace(PUBLIC_URL, base));
    assert.equal(meta.headers.get("content-type"), "application/json");
    assert.equal(meta.headers.get("access-control-allow-origin"), "*");
    assert.equal((await meta.json()).image, image);
    const picture = await fetch(image.replace(PUBLIC_URL, base));
    assert.equal(picture.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await picture.arrayBuffer()), PNG);
    assert.equal((await fetch(`${base}/i/../../coins.json`)).status, 404);
  });

  it("refuses bad requests plainly", async () => {
    const forbidden = await fetch(`${base}/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] }) });
    assert.equal(forbidden.status, 403);
    const badUpload = await fetch(`${base}/launch/upload`, { method: "POST", body: JSON.stringify({ name: "", symbol: "X", image: PNG.toString("base64") }) });
    assert.equal(badUpload.status, 400);
    assert.match((await badUpload.json()).error, /Name/);
    const badSignature = await fetch(`${base}/launch/register`, { method: "POST", body: JSON.stringify({ signature: "nope" }) });
    assert.equal(badSignature.status, 400);
    assert.equal((await fetch(`${base}/coins?kind=hot`)).status, 400);
    assert.deepEqual(await (await fetch(`${base}/coins?kind=new`)).json(), { coins: [] });
  });
});
