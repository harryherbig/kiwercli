/**
 * Browser transport: runs each request as fetch() in a rewe.de tab of a Chromium
 * the user is already logged into, via the Chrome DevTools Protocol.
 */

const SHOP_URL = "https://www.rewe.de/shop/";
const TIMEOUT_MS = 30000;

export interface BrowserResponse {
  status: number;
  /** Response text, or base64 when `binary` was requested. */
  body: string;
}

export interface BrowserRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  binary?: boolean;
}

/** Runs inside the page; must stay self-contained. */
async function pageFetch(a: BrowserRequest): Promise<BrowserResponse> {
  const r = await fetch(a.url, { method: a.method, headers: a.headers, body: a.body, credentials: "include" });
  if (!a.binary) return { status: r.status, body: await r.text() };
  const bytes = new Uint8Array(await r.arrayBuffer());
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return { status: r.status, body: btoa(s) };
}

export async function browserFetch(req: BrowserRequest): Promise<BrowserResponse> {
  const cdpUrl = process.env.KIWERCLI_CDP_URL || "http://127.0.0.1:9223";
  let wsUrl: string;
  try {
    const version = await fetch(`${cdpUrl}/json/version`).then((r) => r.json());
    wsUrl = version.webSocketDebuggerUrl;
  } catch {
    throw new Error(`No Chromium with remote debugging at ${cdpUrl} (set KIWERCLI_CDP_URL).`);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`CDP connection to ${wsUrl} failed.`));
  });

  let nextId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(msg: any) => void>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`));
      else p.resolve(msg.result);
    }
    for (const l of listeners) l(msg);
  };
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const event = (method: string, sessionId: string) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), TIMEOUT_MS).unref();
      listeners.add((m) => {
        if (m.method === method && m.sessionId === sessionId) {
          clearTimeout(t);
          resolve();
        }
      });
    });

  let targetId: string | undefined;
  try {
    ({ targetId } = await send("Target.createTarget", { url: "about:blank", background: true }));
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await Promise.all([
      event("Page.domContentEventFired", sessionId),
      send("Page.navigate", { url: SHOP_URL }, sessionId),
    ]);
    const res = await send(
      "Runtime.evaluate",
      { expression: `(${pageFetch})(${JSON.stringify(req)})`, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(`Browser fetch failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value as BrowserResponse;
  } finally {
    if (targetId) await send("Target.closeTarget", { targetId }).catch(() => {});
    ws.close();
  }
}
