import crypto from "node:crypto";
import http from "node:http";
import { UiHandler } from "./ui.js";

const MAX_BODY_BYTES = 16 * 1024;
export const TOKEN_HEADER = "x-pumpv-token";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(json);
}

function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
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
      if (size === 0) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The local API the GTA mod talks to. Only 127.0.0.1 is bound, and every
 * request must carry the random token from connection.json. Browsers are
 * shut out twice over: a web page cannot read that token, and any request
 * with an Origin header (which browsers always attach to cross-site
 * fetches) or a foreign Host header (DNS rebinding) is refused.
 */
export function createServer(app: UiHandler, opts:{ token: string; port: number; log?: (m: string) => void }): http.Server {
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
      if (!allowedHosts.has(String(req.headers.host ?? ""))) return send(res, 403, { error: "bad host" });
      if (req.headers.origin !== undefined) return send(res, 403, { error: "browsers not allowed" });
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, app: "pumpv" });
      if (!tokenMatches(req.headers[TOKEN_HEADER], opts.token)) return send(res, 401, { error: "bad token" });
      if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method" });

      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        const type = String(req.headers["content-type"] ?? "");
        if (!type.startsWith("application/json")) return send(res, 415, { error: "json only" });
        try {
          body = await readBody(req);
        } catch (e) {
          return send(res, 400, { error: (e as Error).message });
        }
      }
      if (!url.pathname.startsWith("/ui/")) return send(res, 404, { error: "not found" });
      const out = await app.handle(req.method, url, body);
      if (!out) return send(res, 404, { error: "not found" });
      return send(res, 200, out);
    } catch (e) {
      opts.log?.(`server error: ${(e as Error).stack ?? String(e)}`);
      if (!res.headersSent) send(res, 500, { error: "internal" });
    }
  });
}

export function newApiToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}
