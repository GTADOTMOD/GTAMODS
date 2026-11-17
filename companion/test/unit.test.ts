import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BN from "bn.js";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ConfigError, DEFAULT_CONFIG, validateConfig } from "../src/config.js";
import { fmtCompact, fmtSol, fmtUsd, phoneText, solToLamports, ticker } from "../src/format.js";
import { latestImage, resolveImage } from "../src/images.js";
import { KeystoreFile, WrongPasswordError, decryptKeypair, encryptKeypair, parseSecretKey } from "../src/keystore.js";
import { MetaResolver, decodeMetaplexMetadata, decodeToken2022Metadata, metaplexMetadataPda } from "../src/metadata.js";
import { SolPrice, decodeSolPrice } from "../src/price.js";
import { FakeConnection, encodeSolPrice, seedSolPrice } from "./fakeChain.js";
import { applyMinSlippage, budgetUnderCap, slippageTenths, solAmountForMin } from "../src/pump.js";
import { BuiltTx, explainFailure, parsePublicKey, sendAndConfirm } from "../src/solana.js";
import { QuoteStore } from "../src/store.js";
import { parseSolInput } from "../src/ui.js";

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const MINT = "So11111111111111111111111111111111111111112";

describe("keystore", () => {
  it("round-trips and rejects a wrong password", () => {
    const kp = Keypair.generate();
    const ks = encryptKeypair(kp, "correct horse battery", FAST_KDF);
    assert.equal(ks.address, kp.publicKey.toBase58());
    assert.ok(!JSON.stringify(ks).includes(bs58.encode(kp.secretKey)), "secret not stored in clear");
    assert.deepEqual(decryptKeypair(ks, "correct horse battery").secretKey, kp.secretKey);
    assert.throws(() => decryptKeypair(ks, "wrong password!!"), WrongPasswordError);
  });

  it("detects a swapped address", () => {
    const ks = encryptKeypair(Keypair.generate(), "correct horse battery", FAST_KDF);
    const tampered: KeystoreFile = { ...ks, address: Keypair.generate().publicKey.toBase58() };
    assert.throws(() => decryptKeypair(tampered, "correct horse battery"), WrongPasswordError);
  });

  it("refuses short passwords", () => {
    assert.throws(() => encryptKeypair(Keypair.generate(), "short", FAST_KDF), /at least/);
  });

  it("imports base58 and JSON-array secret keys", () => {
    const kp = Keypair.generate();
    assert.ok(parseSecretKey(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey));
    assert.ok(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey));
    assert.throws(() => parseSecretKey(bs58.encode(kp.secretKey.slice(0, 32))), /64 bytes/);
    assert.throws(() => parseSecretKey("not base58 0OIl"), /base58/);
  });
});

describe("config", () => {
  it("accepts defaults and partial overrides", () => {
    assert.deepEqual(validateConfig(undefined), DEFAULT_CONFIG);
    const c = validateConfig({ dryRun: false, slippagePercent: 5 });
    assert.equal(c.dryRun, false);
    assert.equal(c.slippagePercent, 5);
    assert.equal(c.maxSolPerTrade, DEFAULT_CONFIG.maxSolPerTrade);
  });

  it("rejects dangerous values", () => {
    const bad: Record<string, unknown>[] = [
      { rpcUrl: "http://evil.example.com" },
      { slippagePercent: 0 },
      { slippagePercent: 80 },
      { maxSolPerTrade: -1 },
      { buyPresetsSol: [0.1, 5] }, // above maxSolPerTrade
      { sellPresetsPercent: [150] },
      { priorityFeeMicroLamports: 1e12 },
      { port: 80 },
      { dryRun: "no" },
      { apiUrl: "http://evil.example.com" },
      { apiUrl: "not a url" },
    ];
    for (const b of bad) assert.throws(() => validateConfig(b), ConfigError, JSON.stringify(b));
    assert.doesNotThrow(() => validateConfig({ rpcUrl: "http://127.0.0.1:8899" }));
  });

  it("uses RUGR's RPC by default, and moves old configs off the public one", () => {
    assert.equal(DEFAULT_CONFIG.rpcUrl, `${DEFAULT_CONFIG.apiUrl}/rpc`);
    assert.equal(validateConfig({ rpcUrl: "https://api.mainnet-beta.solana.com" }).rpcUrl, DEFAULT_CONFIG.rpcUrl);
    assert.equal(validateConfig({ apiUrl: "http://127.0.0.1:8080/" }).rpcUrl, "http://127.0.0.1:8080/rpc", "the RPC follows the server");
    assert.equal(validateConfig({ rpcUrl: "https://my-own-rpc.example.com" }).rpcUrl, "https://my-own-rpc.example.com", "a player's own RPC stays");
    const legacy = validateConfig({ pinataJwt: "jwt", ipfsUploadUrl: "https://pump.fun/api/ipfs" }) as unknown as Record<string, unknown>;
    assert.ok(!("pinataJwt" in legacy) && !("ipfsUploadUrl" in legacy), "launches upload through RUGR now");
  });
});

describe("formatting", () => {
  it("converts SOL to lamports exactly", () => {
    assert.equal(solToLamports(0.1).toString(), "100000000");
    assert.equal(solToLamports(1.000000001).toString(), "1000000001");
    assert.equal(solToLamports(0.3).toString(), "300000000");
  });

  it("formats amounts for a small screen", () => {
    assert.equal(fmtSol(1.23456), "1.235");
    assert.equal(fmtSol(57.2271), "57.23");
    assert.equal(fmtSol(0.05), "0.05");
    assert.equal(fmtSol(0.0000000572), "0.0000000572");
    assert.equal(fmtCompact(3_910_000), "3.91M");
    assert.equal(fmtCompact(250_000_000), "250M");
    assert.equal(fmtUsd(230_000), "$230K");
    assert.equal(fmtUsd(43_900), "$43.9K");
    assert.equal(fmtUsd(0.96), "$0.96");
    assert.equal(fmtUsd(0.0000236), "$0.0000236");
  });

  it("strips GTA formatting codes and unsupported glyphs from internet text", () => {
    assert.equal(phoneText("~r~RED~n~coin 🚀"), "REDcoin");
    assert.equal(phoneText("a".repeat(50), 10), "aaaaaaaa..");
    assert.equal(ticker("pepe", MINT), "$pepe");
    assert.equal(ticker("$BONKERS", MINT), "$BONKERS");
    assert.equal(ticker("", MINT), "So11..1112");
  });

  it("parses typed SOL amounts", () => {
    assert.equal(parseSolInput("0,25"), 0.25);
    assert.equal(parseSolInput(".5"), 0.5);
    assert.throws(() => parseSolInput("1e3"));
    assert.throws(() => parseSolInput("-1"));
    assert.throws(() => parseSolInput("0"));
  });
});

describe("slippage math", () => {
  it("never lets the SDK's cost cap exceed what the player chose", () => {
    for (const pct of [0.5, 1, 7.5, 10, 25, 50]) {
      const t = slippageTenths(pct);
      for (const cap of [1n, 999n, 100_000_000n, 123_456_789n, 10_000_000_000n]) {
        const capBn = new BN(cap.toString());
        const budget = budgetUnderCap(capBn, t);
        // Same arithmetic as PumpSdk.buyInstruction's max_sol_cost.
        const maxCost = budget.add(budget.mul(new BN(t)).div(new BN(1000)));
        assert.ok(maxCost.lte(capBn), `pct=${pct} cap=${cap} maxCost=${maxCost}`);
      }
    }
  });

  it("makes the SDK's sell minimum land on the quoted minimum", () => {
    for (const pct of [1, 7.5, 10, 33]) {
      const t = slippageTenths(pct);
      for (const expected of [1_000n, 54_321_987n, 9_876_543_210n]) {
        const min = applyMinSlippage(new BN(expected.toString()), t);
        const sol = solAmountForMin(min, t);
        // Same arithmetic as PumpSdk.sellInstructions' min_sol_output.
        const chainMin = sol.sub(sol.mul(new BN(t)).div(new BN(1000)));
        assert.ok(chainMin.gte(min), `chain min ${chainMin} >= ${min}`);
        assert.ok(chainMin.sub(min).lten(1), "and no more than 1 lamport above");
      }
    }
  });
});

describe("SOL price", () => {
  const NOW = 1_800_000_000_000;

  it("reads a fresh SOL price and rejects anything else", () => {
    assert.ok(Math.abs(decodeSolPrice(encodeSolPrice(95.82, NOW), NOW)! - 95.82) < 1e-6);
    assert.equal(decodeSolPrice(encodeSolPrice(95.82, NOW - 301_000), NOW), null, "too old");
    assert.equal(decodeSolPrice(encodeSolPrice(95.82, NOW, "00".repeat(32)), NOW), null, "another coin's feed");
    assert.equal(decodeSolPrice(encodeSolPrice(-1, NOW), NOW), null, "nonsense price");
    assert.equal(decodeSolPrice(Buffer.alloc(10), NOW), null, "too short");
  });

  it("falls back to no price when the account can't be read", async () => {
    const fc = new FakeConnection();
    assert.equal(await new SolPrice(fc.asConnection()).get(), null);
    seedSolPrice(fc, 100);
    assert.equal(await new SolPrice(fc.asConnection()).get(), 100);
    const failing = { getAccountInfo: async () => { throw new Error("rpc down"); } };
    assert.equal(await new SolPrice(failing as never).get(), null);
  });
});

describe("sending", () => {
  /** A connection that answers each status poll from a script, and counts what it was asked. */
  function chain(statuses: (Record<string, unknown> | null)[], height = 100) {
    const asked = { sends: 0, polls: 0 };
    const connection = {
      sendRawTransaction: async () => {
        asked.sends++;
        return "Sig1111111111111111111111111111111111111111111111111111111111111";
      },
      getSignatureStatuses: async () => ({ value: [statuses[Math.min(asked.polls++, statuses.length - 1)]] }),
      getBlockHeight: async () => height,
    };
    return { connection: connection as never, asked };
  }
  const built = { tx: { serialize: () => Buffer.from([1]) }, blockhash: "b", lastValidBlockHeight: 150 } as unknown as BuiltTx;
  const noWait = async () => undefined;

  it("confirms by asking for the status, and sends again while it waits", async () => {
    const { connection, asked } = chain([null, null, null, { confirmationStatus: "confirmed", err: null }]);
    assert.match(await sendAndConfirm(connection, built, noWait), /^Sig/);
    assert.equal(asked.polls, 4);
    assert.equal(asked.sends, 2, "the first send, and once more after three polls");
  });

  it("says plainly when it failed on-chain, or expired before it could land", async () => {
    await assert.rejects(sendAndConfirm(chain([{ confirmationStatus: "processed", err: { InstructionError: [0, "x"] } }]).connection, built, noWait), /failed on-chain/);
    await assert.rejects(sendAndConfirm(chain([null], 151).connection, built, noWait), /expired. Nothing was spent/);
  });
});

describe("misc", () => {
  it("decodes Metaplex metadata strings", () => {
    const str = (s: string, pad: number) => {
      const b = Buffer.alloc(4 + pad);
      b.writeUInt32LE(pad, 0);
      b.write(s, 4);
      return b;
    };
    const data = Buffer.concat([Buffer.alloc(65), str("Doge", 32), str("DOGE", 10), str("https://x/y.json", 200)]);
    assert.deepEqual(decodeMetaplexMetadata(data), { name: "Doge", symbol: "DOGE", uri: "https://x/y.json" });
    assert.equal(decodeMetaplexMetadata(Buffer.alloc(10)), null);
  });

  describe("coin names", () => {
    const str = (s: string) => {
      const b = Buffer.alloc(4 + s.length);
      b.writeUInt32LE(s.length, 0);
      b.write(s, 4);
      return b;
    };
    // A Token-2022 mint with a metadata extension: 165 base bytes, account type, then TLV.
    const token2022Mint = (name: string, symbol: string, uri: string) => {
      const value = Buffer.concat([Buffer.alloc(64), str(name), str(symbol), str(uri), Buffer.alloc(4)]);
      const tlv = Buffer.alloc(4);
      tlv.writeUInt16LE(19, 0); // ExtensionType.TokenMetadata
      tlv.writeUInt16LE(value.length, 2);
      const base = Buffer.alloc(166);
      base[45] = 1; // is_initialized
      base[44] = 6; // decimals
      base[165] = 1; // AccountType.Mint
      return Buffer.concat([base, tlv, value]);
    };
    const metaplexAccount = (name: string, symbol: string, uri: string) => Buffer.concat([Buffer.alloc(65), str(name), str(symbol), str(uri)]);

    it("reads a Token-2022 mint's metadata", () => {
      const mint = Keypair.generate().publicKey;
      const info = { data: token2022Mint("Doge", "DOGE", "https://x/y.json"), owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false };
      assert.deepEqual(decodeToken2022Metadata(mint, info), { name: "Doge", symbol: "DOGE", uri: "https://x/y.json" });
      assert.equal(decodeToken2022Metadata(mint, { ...info, data: Buffer.alloc(10) }), null);
    });

    it("looks names up in one batch, and retries the ones it couldn't get", async () => {
      const fc = new FakeConnection();
      let now = 0;
      const resolver = new MetaResolver(fc.asConnection(), () => now);
      const modern = Keypair.generate().publicKey;
      const legacy = Keypair.generate().publicKey;
      const late = Keypair.generate().publicKey;
      fc.set(modern, token2022Mint("Modern", "NEW", "https://x/new.json"), TOKEN_2022_PROGRAM_ID);
      fc.set(legacy, Buffer.alloc(82), TOKEN_PROGRAM_ID);
      fc.set(metaplexMetadataPda(legacy), metaplexAccount("Legacy", "OLD", "https://x/old.json"), PublicKey.default);
      let calls = 0;
      const realCall = fc.getMultipleAccountsInfo.bind(fc);
      fc.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
        calls++;
        return realCall(keys);
      };
      resolver.fill([modern, legacy, late].map((k) => k.toBase58()));
      await new Promise((r) => setImmediate(r));
      assert.equal(calls, 1, "one request for all three");
      assert.equal(resolver.peek(modern.toBase58())?.symbol, "NEW");
      assert.equal(resolver.peek(legacy.toBase58())?.uri, "https://x/old.json");
      assert.equal(resolver.peek(late.toBase58()), undefined);

      resolver.fill([late.toBase58()]);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls, 1, "not asked again straight away");
      fc.set(metaplexMetadataPda(late), metaplexAccount("Late", "LATE", ""), PublicKey.default);
      now = 61_000;
      resolver.fill([late.toBase58()]);
      await new Promise((r) => setImmediate(r));
      assert.equal(resolver.peek(late.toBase58())?.symbol, "LATE");
    });
  });

  it("quotes are single-use and expire", () => {
    let now = 0;
    const store = new QuoteStore<string>(1000, () => now);
    const a = store.put("a");
    assert.equal(store.take(a), "a");
    assert.equal(store.take(a), undefined);
    const b = store.put("b");
    now = 1001;
    assert.equal(store.take(b), undefined);
  });

  it("only allows images from the images folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpv-img-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pumpv-out-"));
    fs.writeFileSync(path.join(dir, "a.png"), "x");
    fs.writeFileSync(path.join(outside, "secret.png"), "x");
    const bad = ["../a.png", "/etc/passwd", "a.txt", "", "missing.png", ".hidden.png"];
    try {
      fs.symlinkSync(path.join(outside, "secret.png"), path.join(dir, "link.png"));
      bad.push("link.png");
    } catch (e) {
      // Windows only lets admins and Developer Mode create symlinks.
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
    }
    assert.equal(resolveImage("a.png", dir).mime, "image/png");
    for (const name of bad) {
      assert.throws(() => resolveImage(name, dir), Error, name);
    }
    assert.ok(["a.png", "link.png"].includes(latestImage(dir)!));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("validates addresses and explains failures", () => {
    assert.ok(parsePublicKey(MINT));
    assert.equal(parsePublicKey("0OIl"), null);
    assert.equal(parsePublicKey(""), null);
    assert.match(explainFailure(null, ["Program log: AnchorError. Error Code: TooMuchSolRequired."]), /slippage/);
    assert.match(explainFailure(null, ["Program log: AnchorError. Error Code: Overflow."]), /selling less/);
    assert.match(explainFailure("Attempt to debit an account but found no record of a prior credit.", []), /Transaction would fail/);
  });
});
