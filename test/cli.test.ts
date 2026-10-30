import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the shipped entry point. Network access only via the public product search.
async function kiwercli(args: string[], config?: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), "kiwercli-cli-"));
  await mkdir(join(home, "kiwercli"));
  for (const [file, content] of Object.entries(config ?? {})) {
    await writeFile(join(home, "kiwercli", file), content);
  }
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home },
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { ...r, home };
}

function commandNames(sub: string[]): string[] {
  const help = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...sub, "--help"], { encoding: "utf-8" }).stdout;
  return (help.split("Commands:")[1] ?? "").split("\n").map((l) => l.trim().split(/\s/)[0]).filter((n) => n && n !== "help");
}

test("no command submits an order", () => {
  const root = commandNames([]);
  assert.ok(root.includes("orders"));
  for (const name of root) {
    for (const n of [name, ...commandNames([name])]) {
      assert.doesNotMatch(n, /checkout|submit|place|buy|bestell|pay/i, `${name} ${n}`);
    }
  }
});

test("no scripted login, captcha solving or bot stealth", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.doesNotMatch(dep, /captcha|stealth|puppeteer|playwright/i, dep);
  }
  assert.ok(commandNames([]).includes("import-cookies"));
  for (const n of commandNames([])) assert.doesNotMatch(n, /login|verify|totp/i, n);
});

test("import-cookies accepts a CDP JSON export without login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kiwercli-ck-"));
  const file = join(dir, "cookies.json");
  await writeFile(file, JSON.stringify({ cookies: [
    { name: "rstp", value: "fake", domain: ".rewe.de", path: "/", expires: -1, session: true, httpOnly: true, secure: true },
    { name: "other", value: "x", domain: ".example.com", path: "/", expires: -1 },
  ] }));
  const r = await kiwercli(["import-cookies", file]);
  assert.equal(r.status, 0, r.stderr);
  const session = JSON.parse(await readFile(join(r.home, "kiwercli", "session.json"), "utf-8"));
  assert.deepEqual(session.cookies.map((c: { name: string }) => c.name), ["rstp"]);
});

test("store set-delivery rejects malformed ZIP without a request", async () => {
  const r = await kiwercli(["store", "set-delivery", "5066"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid ZIP/);
});

// 320509 is the delivery market for 50667 (Köln), resolved via set-delivery when this test was written.
const DELIVERY_CONFIG = { selected_store: "320509", selected_zip: "50667" };

// Live: from some networks Cloudflare answers the CLI's search with 403, so opt in.
test("search uses the configured DELIVERY service type (public search)", { skip: !process.env.KIWERCLI_LIVE }, async () => {
  const delivery = await kiwercli(["search", "milch", "--per-page", "3"], { ...DELIVERY_CONFIG, selected_service: "DELIVERY" });
  assert.equal(delivery.status, 0, delivery.stderr);
  assert.ok(JSON.parse(delivery.stdout).length > 0, "delivery market returns products for DELIVERY");

  // Same market as PICKUP has no listings — proves the service type reaches the request.
  const pickup = await kiwercli(["search", "milch", "--per-page", "3"], { ...DELIVERY_CONFIG, selected_service: "PICKUP" });
  assert.equal(pickup.status, 0, pickup.stderr);
  assert.equal(JSON.parse(pickup.stdout).length, 0);
});
