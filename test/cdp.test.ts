import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import type { AddressInfo, Socket } from "node:net";
import { ReweHttpClient } from "../src/http/client.js";

// ── Fake Chromium: /json/version + a minimal WebSocket CDP endpoint ──

type PageReply = { status: number; body: string | Uint8Array } | Error;
let pageReply: (url: string) => PageReply;
let cdpLog: { method: string; params: any; sessionId?: string }[];
let pageFetches: { url: string; init: any }[];
let pageLoaded = false;
let navigateFails = false;

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len])
    : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255])
    : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

async function evaluate(expression: string) {
  const fetch = async (url: string, init: any) => {
    pageFetches.push({ url, init: JSON.parse(JSON.stringify(init)) }); // leave the vm realm
    const r = pageReply(url);
    if (r instanceof Error) throw r;
    const bytes = typeof r.body === "string" ? new TextEncoder().encode(r.body) : r.body;
    return { status: r.status, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer };
  };
  try {
    const value = await vm.runInNewContext(expression, { fetch, btoa, Uint8Array, String });
    return { result: { type: "object", value: JSON.parse(JSON.stringify(value)) } };
  } catch (e) {
    return { result: {}, exceptionDetails: { text: "Uncaught", exception: { description: String(e) } } };
  }
}

async function onMessage(sock: Socket, msg: any) {
  cdpLog.push(msg);
  const reply = (result: object) => sock.write(frame(JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId })));
  switch (msg.method) {
    case "Target.createTarget":
      pageLoaded = false;
      return reply({ targetId: "T1" });
    case "Target.attachToTarget": return reply({ sessionId: "S1" });
    case "Page.navigate":
      if (navigateFails) return sock.write(frame(JSON.stringify({ id: msg.id, error: { code: -32000, message: "Cannot navigate" }, sessionId: msg.sessionId })));
      reply({ frameId: "F1" });
      return setTimeout(() => {
        pageLoaded = true;
        sock.write(frame(JSON.stringify({ method: "Page.domContentEventFired", params: {}, sessionId: msg.sessionId })));
      }, 20);
    case "Runtime.evaluate":
      // Like Chromium: before the shop page has loaded, the tab is still about:blank.
      if (!pageLoaded) return reply({ result: {}, exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: Failed to fetch (about:blank)" } } });
      return reply(await evaluate(msg.params.expression));
    default: return reply({});
  }
}

let server: Server;
let cdpUrl: string;

before(async () => {
  server = createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
  });
  server.on("upgrade", (req, sock: Socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
        const opcode = buf[0] & 15;
        buf = buf.subarray(off + 4 + len);
        if (opcode === 8) return sock.end();
        if (opcode === 1) onMessage(sock, JSON.parse(data.toString()));
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cdpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  cdpLog = [];
  pageFetches = [];
  pageReply = () => ({ status: 200, body: "{}" });
  process.env.KIWERCLI_TRANSPORT = "browser";
  process.env.KIWERCLI_CDP_URL = cdpUrl;
});

const methods = () => cdpLog.map((m) => m.method);

// ── Transport ──

test("GET runs fetch with credentials in a rewe.de/shop tab and closes it", async () => {
  pageReply = () => ({ status: 200, body: '{"ok":true}' });
  const res = await new ReweHttpClient().get("/orders", { "rd-market-id": "320509" });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(methods(), ["Target.createTarget", "Target.attachToTarget", "Page.enable", "Page.navigate", "Runtime.evaluate", "Target.closeTarget"]);
  assert.equal(cdpLog[3].params.url, "https://www.rewe.de/shop/");
  assert.equal(cdpLog[4].params.awaitPromise, true);
  assert.equal(cdpLog[4].sessionId, "S1");
  assert.equal(cdpLog[5].params.targetId, "T1");
  assert.equal(pageFetches[0].url, "https://www.rewe.de/shop/api/orders");
  assert.equal(pageFetches[0].init.method, "GET");
  assert.equal(pageFetches[0].init.credentials, "include");
  assert.deepEqual(pageFetches[0].init.headers, { "rd-market-id": "320509" });
});

test("POST sends JSON body with content type; HTML comes back as text", async () => {
  await new ReweHttpClient().post("/baskets/listings/x", {}, { quantity: 2 });
  assert.equal(pageFetches[0].init.body, '{"quantity":2}');
  assert.equal(pageFetches[0].init.headers["Content-Type"], "application/json");
  pageReply = () => ({ status: 200, body: "<html><line-item></line-item></html>" });
  assert.equal(await new ReweHttpClient().get("https://www.rewe.de/shop/mydata/orderdetail/1"), "<html><line-item></line-item></html>");
});

test("401 and 403 ask to log in in the browser; tab is still closed", async () => {
  for (const status of [401, 403]) {
    cdpLog = [];
    pageReply = () => ({ status, body: "" });
    await assert.rejects(new ReweHttpClient().get("/orders"), /Im Browser bei rewe\.de einloggen/);
    assert.equal(methods().at(-1), "Target.closeTarget");
  }
  pageReply = () => ({ status: 400, body: "bad" });
  await assert.rejects(new ReweHttpClient().get("/orders"), /API error 400 GET .*: bad/);
});

test("fetch failure inside the page is reported and the tab closed", async () => {
  pageReply = () => new TypeError("Failed to fetch");
  await assert.rejects(new ReweHttpClient().get("/orders"), /Browser fetch failed: TypeError: Failed to fetch/);
  assert.equal(methods().at(-1), "Target.closeTarget");
});

test("failed navigation rejects at once and closes the tab", async () => {
  navigateFails = true;
  try {
    const t0 = Date.now();
    await assert.rejects(new ReweHttpClient().get("/orders"), /CDP Cannot navigate/);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(methods().at(-1), "Target.closeTarget");
  } finally {
    navigateFails = false;
  }
});

test("getBytes returns the binary body unchanged", async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80]);
  pageReply = () => ({ status: 200, body: pdf });
  assert.deepEqual([...(await new ReweHttpClient().getBytes("/receipts/1/pdf"))], [...pdf]);
});

test("unreachable CDP names KIWERCLI_CDP_URL", async () => {
  process.env.KIWERCLI_CDP_URL = "http://127.0.0.1:9";
  await assert.rejects(new ReweHttpClient().get("/orders"), /No Chromium with remote debugging at http:\/\/127\.0\.0\.1:9 \(set KIWERCLI_CDP_URL\)/);
});

test("transport selection: default axios never touches CDP, unknown value fails", async () => {
  const plain = createServer((req, res) => {
    res.statusCode = req.url === "/denied" ? 403 : 200;
    res.end('{"via":"axios"}');
  });
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(plain.address() as AddressInfo).port}/x`;
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), "kiwercli-ax-"));
  try {
    delete process.env.KIWERCLI_TRANSPORT;
    assert.deepEqual(await new ReweHttpClient().get(url), { via: "axios" });
    process.env.KIWERCLI_TRANSPORT = "axios";
    assert.deepEqual(await new ReweHttpClient().get(url), { via: "axios" });
    await assert.rejects(new ReweHttpClient().get(url.replace("/x", "/denied")), /re-run `kiwercli import-cookies` or set KIWERCLI_TRANSPORT=browser/);
    assert.equal(cdpLog.length, 0);
    process.env.KIWERCLI_TRANSPORT = "Browser";
    await assert.rejects(new ReweHttpClient().get(url), /KIWERCLI_TRANSPORT must be "axios" or "browser"/);
  } finally {
    plain.close();
  }
});

// ── Shipped entry point ──

test("CLI orders items works via browser transport without session.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "kiwercli-cli-"));
  await mkdir(join(home, "kiwercli"));
  await writeFile(join(home, "kiwercli", "selected_store"), "320509");
  await writeFile(join(home, "kiwercli", "selected_zip"), "50667");
  await writeFile(join(home, "kiwercli", "selected_service"), "DELIVERY");
  pageReply = (url) => url.includes("/shop/api/orders/")
    ? { status: 200, body: JSON.stringify({ subOrders: [{ lineItems: [{ productId: "7832969", title: "Toilettenpapier", quantity: 1, price: 379 }] }] }) }
    : { status: 404, body: "" };
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", "orders", "items", "abc-1"], {
    env: { ...process.env, XDG_CONFIG_HOME: home, KIWERCLI_TRANSPORT: "browser", KIWERCLI_CDP_URL: cdpUrl },
  });
  assert.deepEqual(JSON.parse(stdout), [{ name: "Toilettenpapier", productId: "7832969", quantity: 1, price: 379 }]);
  assert.equal(pageFetches[0].init.headers["rd-service-types"], "DELIVERY");
});
