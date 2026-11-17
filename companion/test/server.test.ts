import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../src/server.js";
import { PhoneApp } from "../src/ui.js";

const TOKEN = "test-token-1234567890";

function request(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/ui/home", headers: opts.headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("local server security", () => {
  let server: http.Server;
  let port = 0;
  const calls: string[] = [];

  before(async () => {
    const fakeApp = {
      handle: async (method: string, url: URL, body: Record<string, unknown>) => {
        calls.push(`${method} ${url.pathname} ${JSON.stringify(body)}`);
        return url.pathname === "/ui/home" ? { nav: "push", screen: { header: "ok" } } : null;
      },
    } as unknown as PhoneApp;
    // Port must be known before creating the server (Host check), so grab a free one first.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    server = createServer(fakeApp, { token: TOKEN, port });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  const host = () => `127.0.0.1:${port}`;

  it("health needs no token and leaks nothing", async () => {
    const r = await request(port, { path: "/health", headers: { Host: host() } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, app: "pumpv" });
  });

  it("requires the token", async () => {
    assert.equal((await request(port, { headers: { Host: host() } })).status, 401);
    assert.equal((await request(port, { headers: { Host: host(), "X-PumpV-Token": "wrong" } })).status, 401);
    const ok = await request(port, { headers: { Host: host(), "X-PumpV-Token": TOKEN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.screen.header, "ok");
  });

  it("refuses browsers and DNS rebinding even with the token", async () => {
    const withOrigin = await request(port, { headers: { Host: host(), Origin: "https://evil.example", "X-PumpV-Token": TOKEN } });
    assert.equal(withOrigin.status, 403);
    const rebinding = await request(port, { headers: { Host: `evil.example:${port}`, "X-PumpV-Token": TOKEN } });
    assert.equal(rebinding.status, 403);
  });

  it("only takes JSON bodies of sane size", async () => {
    const h = { Host: host(), "X-PumpV-Token": TOKEN };
    const form = await request(port, { method: "POST", path: "/ui/execute", headers: { ...h, "Content-Type": "text/plain" }, body: "quoteId=x" });
    assert.equal(form.status, 415);
    const huge = await request(port, { method: "POST", path: "/ui/execute", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ x: "a".repeat(20_000) }) }).catch(() => ({ status: 400 }));
    assert.equal(huge.status, 400);
    const notFound = await request(port, { path: "/ui/nope", headers: h });
    assert.equal(notFound.status, 404);
    assert.ok(!calls.some((c) => c.includes("aaaa")), "oversized body never reached the app");
  });
});
