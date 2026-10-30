import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReweApi, deliveryMarket, parseOrderDetailHtml } from "../src/api/index.js";
import { parseCookieFile } from "../src/storage/cookies.js";
import { readSettings } from "../src/storage/index.js";
import type { ReweHttpClient } from "../src/http/client.js";
import type { CurrentStore } from "../src/storage/index.js";

type Call = { path: string; headers?: Record<string, string>; params?: Record<string, unknown> };

function fakeClient(respond: (path: string) => unknown) {
  const calls: Call[] = [];
  const client = {
    async get(path: string, headers?: Record<string, string>, params?: Record<string, unknown>) {
      calls.push({ path, headers, params });
      const r = respond(path);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as ReweHttpClient;
  return { client, calls };
}

const DELIVERY: CurrentStore = { wwIdent: "320509", zipCode: "50667", serviceType: "DELIVERY" };
const PICKUP: CurrentStore = { wwIdent: "840254", zipCode: "66113", serviceType: "PICKUP" };

test("delivery store sends DELIVERY header, search param and timeslot path", async () => {
  const { client, calls } = fakeClient(() => ({}));
  const api = new ReweApi(client, DELIVERY);
  await api.timeslots();
  await api.search("milch");
  assert.equal(calls[0].path, "/timeslots/delivery/overview");
  assert.equal(calls[0].headers?.["rd-service-types"], "DELIVERY");
  assert.equal(calls[1].params?.serviceTypes, "DELIVERY");
  assert.equal(calls[1].params?.market, "320509");
});

test("pickup store keeps pickup header and timeslot path", async () => {
  const { client, calls } = fakeClient(() => ({}));
  await new ReweApi(client, PICKUP).timeslots();
  assert.equal(calls[0].path, "/timeslots/pickup/overview");
  assert.equal(calls[0].headers?.["rd-service-types"], "PICKUP");
});

test("deliveryMarket returns wwIdent, rejects no-delivery ZIPs", async () => {
  const ok = fakeClient(() => ({ deliveryMarketWwIdent: "320509" }));
  assert.equal(await deliveryMarket(ok.client, "50667"), "320509");
  assert.equal(ok.calls[0].path, "/marketselection/zipcodes/50667/services");
  const none = fakeClient(() => ({ deliveryMarketWwIdent: null }));
  await assert.rejects(deliveryMarket(none.client, "66113"), /delivers nowhere/);
});

test("deliveryMarket accepts exactly 5 digits before any request", async () => {
  const { client, calls } = fakeClient(() => ({ deliveryMarketWwIdent: "1" }));
  await assert.rejects(deliveryMarket(client, "5066"), /Invalid ZIP/); // 4 digits
  await assert.rejects(deliveryMarket(client, "506670"), /Invalid ZIP/); // 6 digits
  await assert.rejects(deliveryMarket(client, "../x"), /Invalid ZIP/);
  assert.equal(calls.length, 0);
  assert.equal(await deliveryMarket(client, "50667"), "1"); // 5 digits
});

test("readSettings defaults to PICKUP for configs written before delivery support", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kiwercli-"));
  process.env.XDG_CONFIG_HOME = dir;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "kiwercli"));
  await writeFile(join(dir, "kiwercli", "selected_store"), "840254");
  await writeFile(join(dir, "kiwercli", "selected_zip"), "66113");
  assert.equal((await readSettings()).serviceType, "PICKUP");
  await writeFile(join(dir, "kiwercli", "selected_service"), "DELIVERY");
  assert.equal((await readSettings()).serviceType, "DELIVERY");
});

test("Netscape import keeps #HttpOnly_ cookies and skips comments", () => {
  const text = [
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.rewe.de\tTRUE\t/\tTRUE\t0\trstp\tfake-rstp",
    ".rewe.de\tTRUE\t/\tFALSE\t1893456000\tmarketsCookie\tfake",
  ].join("\n");
  const cookies = parseCookieFile(text);
  assert.deepEqual(cookies.map((c) => [c.name, c.httpOnly, c.expires]), [
    ["rstp", true, -1],
    ["marketsCookie", false, 1893456000],
  ]);
});

test("JSON import reads CDP getAllCookies and bare arrays", () => {
  const cdp = JSON.stringify({
    cookies: [
      { name: "rstp", value: "fake", domain: ".rewe.de", path: "/", expires: -1, session: true, httpOnly: true, secure: true, sameSite: "None" },
      { name: "a", value: "b", domain: "www.rewe.de", path: "/", expires: 1893456000, httpOnly: false, secure: false },
    ],
  });
  const c = parseCookieFile(cdp);
  assert.deepEqual(c[0], { name: "rstp", value: "fake", domain: ".rewe.de", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" });
  assert.equal(c[1].expires, 1893456000);
  assert.equal(c[1].sameSite, "Lax");
  const arr = parseCookieFile(`[{"name":"x","value":"y","domain":".rewe.de","expirationDate":1893456000}]`);
  assert.equal(arr[0].expires, 1893456000);
  assert.equal(arr[0].path, "/");
  assert.throws(() => parseCookieFile(`{"foo":1}`), /no cookies array/);
});

// First item: real markup from an order page. Second: same structure, values changed
// so that unit price (x-price) differs from total (x-total-price).
const ORDER_HTML = `<div role="table">
<a class="line-item-link with-border-bottom" href="/shop/products/7832969"><line-item aria-rowindex="5" role="row"><x-category class="hide-visually" role="cell">Drogerie &amp; Gesundheit</x-category><x-article role="cell"><img alt="" src="..."><div>natürlich ECO Recycling Toilettenpapier 4-lagig 8x160 Blatt</div></x-article><x-amount role="cell"><span>1</span></x-amount><x-price role="cell"><x-price-descriptor aria-hidden="aria-hidden">Einzelpreis</x-price-descriptor>3,79 €</x-price><x-total-price role="cell"><x-total-price-descriptor aria-hidden="aria-hidden">Gesamtpreis</x-total-price-descriptor>3,79 €</x-total-price></line-item></a>
<a class="line-item-link with-border-bottom" href="/shop/products/1234567"><line-item aria-rowindex="6" role="row"><x-category class="hide-visually" role="cell">Kaffee</x-category><x-article role="cell"><img alt="" src="..."><div>Ben &amp; Jerry's Cookie Dough 465ml</div></x-article><x-amount role="cell"><span>2</span></x-amount><x-price role="cell"><x-price-descriptor aria-hidden="aria-hidden">Einzelpreis</x-price-descriptor>12,49 €</x-price><x-total-price role="cell"><x-total-price-descriptor aria-hidden="aria-hidden">Gesamtpreis</x-total-price-descriptor>24,98 €</x-total-price></line-item></a>
</div>`;

test("parseOrderDetailHtml extracts one item per line-item block", () => {
  assert.deepEqual(parseOrderDetailHtml(ORDER_HTML), [
    { name: "natürlich ECO Recycling Toilettenpapier 4-lagig 8x160 Blatt", productId: "7832969", quantity: 1, price: 379 },
    { name: "Ben & Jerry's Cookie Dough 465ml", productId: "1234567", quantity: 2, price: 1249 },
  ]);
  assert.deepEqual(parseOrderDetailHtml("<html>login</html>"), []);
});

test("orderItems uses API line items, falls back to HTML, validates ID", async () => {
  const api = fakeClient(() => ({
    orderDetails: {
      subOrders: [{ lineItems: [
        { lineItemType: "PRODUCT", productId: "p1", title: "Milch", quantity: 3, price: 99, totalPrice: 297 },
        { lineItemType: "DEPOSIT", totalPrice: 25 },
      ] }],
    },
  }));
  assert.deepEqual(await new ReweApi(api.client, DELIVERY).orderItems("abc-1"), [
    { name: "Milch", productId: "p1", quantity: 3, price: 99 },
  ]);

  const html = fakeClient((p) => (p.startsWith("/orders/") ? new Error("API error 500") : ORDER_HTML));
  const items = await new ReweApi(html.client, DELIVERY).orderItems("abc-1");
  assert.equal(items.length, 2);
  assert.equal(html.calls[1].path, "https://www.rewe.de/shop/mydata/orderdetail/abc-1");

  const empty = fakeClient((p) => (p.startsWith("/orders/") ? { subOrders: [{ lineItems: [{ lineItemType: "DEPOSIT", totalPrice: 25 }] }] } : ORDER_HTML));
  assert.equal((await new ReweApi(empty.client, DELIVERY).orderItems("abc-1")).length, 2);

  const bad = fakeClient(() => ({}));
  await assert.rejects(new ReweApi(bad.client, DELIVERY).orderItems("../basket"), /Invalid order ID/);
  assert.equal(bad.calls.length, 0);
});
