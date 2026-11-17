import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Connection } from "@solana/web3.js";
import { CoinBoard, ListKind } from "./coins.js";
import { LAUNCH_REFERENCE, ServerConfig, loadConfig } from "./config.js";
import { ClientError, LaunchScanner, acceptUpload, listIfRugr, readLaunch } from "./launches.js";
import { RateLimiter, clientKey } from "./limits.js";
import { RpcRelay, RpcRequestError, checkCalls, rpcError } from "./rpc.js";
import { Store } from "./store.js";

/*
 * RUGR's server. The app on every player's PC talks to it for three things:
 *   /rpc              Solana, through the private RPC whose key stays here
 *   /launch/...       a new coin's picture and details, then the launch itself to list it
 *   /coins            Trending and New: the coins launched through RUGR, and no others
 * Coin metadata and pictures are served from /m and /i, linked from each coin on-chain.
 */

const MAX_RPC_BODY = 1024 * 1024;
const MAX_UPLOAD_BODY = 6 * 1024 * 1024;
const MAX_UPLOADS_A_DAY = 2000;
const SCAN_EVERY_MS = 20_000;
const REFRESH_EVERY_MS = 20_000;
const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", json: "application/json" };

export function createApp(cfg: ServerConfig, log: (m: string) => void = console.log) {
  const store = new Store(cfg.dataDir);
  const relay = new RpcRelay(cfg, log);
  const privateRpc = new Connection(cfg.rpcUrl, "confirmed");
  const publicRpc = new Connection(cfg.publicRpcUrl, "confirmed");
  // Background work uses the public RPC, so the private one's allowance is kept for players.
  const board = new CoinBoard(publicRpc, store, cfg.network, cfg.jupiterKey, log);
  const scanner = new LaunchScanner(publicRpc, store, cfg.publicUrl, log);
  const limits = {
    rpc: new RateLimiter(25, 120),
    upload: new RateLimiter(6 / 3600, 6),
    register: new RateLimiter(60 / 3600, 30),
    coins: new RateLimiter(4, 20),
    files: new RateLimiter(30, 200),
  };
  let uploadsToday = { day: new Date().toDateString(), count: 0 };

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage, max: number) =>
    new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max) {
          reject(new ClientError(413, "Too big."));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
        } catch {
          reject(new ClientError(400, "Not JSON."));
        }
      });
      req.on("error", reject);
    });

  const serveFile = (res: http.ServerResponse, file: string | null) => {
    if (!file) return send(res, 404, { error: "Not found." });
    const ext = path.extname(file).slice(1);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      // Named by their contents, so they never change.
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(file).pipe(res);
  };

  /** Reads a launch through the private RPC, which sees a fresh transaction soonest, and the public one if that fails. */
  const verify = async (signature: string) => {
    try {
      return await readLaunch(privateRpc, signature);
    } catch {
      return readLaunch(publicRpc, signature);
    }
  };

  const server = http.createServer(async (req, res) => {
    const who = clientKey(req.headers, req.socket.remoteAddress);
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /" || route === "GET /health") {
        return send(res, 200, { ok: true, app: "rugr", network: cfg.network, coins: store.allCoins().length, reference: LAUNCH_REFERENCE.toBase58() });
      }

      if (route === "POST /rpc") {
        const body = await readBody(req, MAX_RPC_BODY);
        let calls: number;
        try {
          calls = checkCalls(body);
        } catch (e) {
          if (e instanceof RpcRequestError) return send(res, e.status, rpcError(-32601, e.message));
          throw e;
        }
        if (!limits.rpc.take(who, calls)) return send(res, 429, rpcError(-32429, "Too many requests. Slow down a little."));
        const out = await relay.relay(body);
        return send(res, out.status === 429 ? 503 : out.status, out.text);
      }

      if (route === "POST /launch/upload") {
        if (!limits.upload.take(who)) throw new ClientError(429, "Too many uploads from here. Try again in a while.");
        const today = new Date().toDateString();
        if (uploadsToday.day !== today) uploadsToday = { day: today, count: 0 };
        if (uploadsToday.count >= MAX_UPLOADS_A_DAY) throw new ClientError(503, "RUGR is taking no more launches today. Try again tomorrow.");
        const body = (await readBody(req, MAX_UPLOAD_BODY)) as Record<string, unknown> | null;
        const out = acceptUpload(store, cfg.publicUrl, body ?? {});
        uploadsToday.count++;
        return send(res, 200, out);
      }

      if (route === "POST /launch/register") {
        if (!limits.register.take(who)) throw new ClientError(429, "Too many requests.");
        const body = (await readBody(req, 4096)) as { signature?: unknown } | null;
        const signature = typeof body?.signature === "string" ? body.signature : "";
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new ClientError(400, "That isn't a transaction signature.");
        const created = await verify(signature);
        if (created === "not confirmed yet") return send(res, 202, { listed: false, reason: created, retry: true });
        if (typeof created === "string") return send(res, 200, { listed: false, reason: created });
        const listed = listIfRugr(store, cfg.publicUrl, created, signature);
        if (typeof listed === "string") return send(res, 200, { listed: false, reason: listed });
        void board.refresh();
        return send(res, 200, { listed: true, coin: listed });
      }

      if (route === "GET /coins") {
        if (!limits.coins.take(who)) throw new ClientError(429, "Too many requests.");
        const kind = url.searchParams.get("kind");
        if (kind !== "trending" && kind !== "new") throw new ClientError(400, "kind is trending or new.");
        return send(res, 200, { coins: board.list(kind as ListKind) });
      }

      if (req.method === "GET" && (url.pathname.startsWith("/m/") || url.pathname.startsWith("/i/"))) {
        if (!limits.files.take(who)) throw new ClientError(429, "Too many requests.");
        const kind = url.pathname.startsWith("/m/") ? "meta" : "images";
        return serveFile(res, store.fileFor(kind, url.pathname.slice(3)));
      }

      return send(res, 404, { error: "Not found." });
    } catch (e) {
      if (e instanceof ClientError) return send(res, e.status, { error: e.message });
      log(`error on ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      return send(res, 500, { error: "Something went wrong on RUGR's side." });
    }
  });

  const every = (ms: number, job: () => Promise<unknown>) => {
    const run = () => job().catch((e) => log(`background: ${(e as Error).message}`)).finally(() => setTimeout(run, ms).unref());
    void run();
  };

  return {
    server,
    store,
    board,
    scanner,
    start() {
      every(SCAN_EVERY_MS, async () => {
        const added = await scanner.scan();
        if (added) {
          log(`listed ${added} new RUGR coin(s) from the chain`);
          await board.refresh();
        }
      });
      every(REFRESH_EVERY_MS, () => board.refresh());
      every(60 * 60_000, async () => {
        const removed = store.sweep();
        if (removed) log(`removed ${removed} unused upload file(s)`);
      });
    },
  };
}

if (require.main === module) {
  const cfg = loadConfig();
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  const app = createApp(cfg, log);
  app.server.listen(cfg.port, () => {
    log(`RUGR server on :${cfg.port} for ${cfg.network}, public at ${cfg.publicUrl}`);
    log(`private RPC ${cfg.rpcUrl === cfg.publicRpcUrl ? "not set: using the public one" : "set"}; data in ${cfg.dataDir}`);
    app.start();
  });
}
