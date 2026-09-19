import { test } from "node:test";
import assert from "node:assert/strict";
import { Konfigo, KonfigoError } from "../src/index";

const mock = (routes: Record<string, () => Response>) =>
  (async (url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer kfg_test");
    return routes[new URL(url).pathname]!();
  }) as unknown as typeof fetch;

const ok = () =>
  mock({
    "/api/v1/flags": () => Response.json({ env: "production", flags: { a: true, b: false } }),
    "/api/v1/config": () => Response.json({ env: "production", config: { timeout: 3000, msg: "hi" } }),
  });

test("refresh caches flags and config", async () => {
  const k = new Konfigo({ apiKey: "kfg_test", baseUrl: "https://x.test/", fetch: ok() });
  assert.equal(k.isEnabled("a"), false);
  await k.refresh();
  assert.equal(k.isEnabled("a"), true);
  assert.equal(k.isEnabled("b", true), false);
  assert.equal(k.isEnabled("missing", true), true);
  assert.equal(k.get("timeout", 1), 3000);
  assert.equal(k.get("nope", "d"), "d");
  assert.equal(k.current?.env, "production");
});

test("errors carry status and retryAfter", async () => {
  const f = mock({
    "/api/v1/flags": () => Response.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": "7" } }),
    "/api/v1/config": () => Response.json({}, { status: 401 }),
  });
  const k = new Konfigo({ apiKey: "kfg_test", baseUrl: "https://x.test", fetch: f });
  await assert.rejects(k.fetchFlags(), (e: KonfigoError) => e.status === 429 && e.retryAfter === 7);
  await assert.rejects(k.fetchConfig(), (e: KonfigoError) => e.status === 401);
});

test("failed refresh keeps previous snapshot", async () => {
  let fail = false;
  const good = ok();
  const f = ((u: string, i: RequestInit) => (fail ? Promise.reject(new Error("down")) : good(u, i))) as unknown as typeof fetch;
  const k = new Konfigo({ apiKey: "kfg_test", baseUrl: "https://x.test", fetch: f });
  await k.refresh();
  fail = true;
  await assert.rejects(k.refresh(), KonfigoError);
  assert.equal(k.isEnabled("a"), true);
});

test("start polls and onChange fires", async () => {
  const k = new Konfigo({ apiKey: "kfg_test", baseUrl: "https://x.test", fetch: ok() });
  let n = 0;
  k.onChange(() => n++);
  await k.start({ intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 55));
  k.stop();
  assert.ok(n >= 3, `expected >=3 refreshes, got ${n}`);
});
