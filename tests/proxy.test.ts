import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

process.env.APP_TOKEN = "secret-token";
process.env.ANTHROPIC_API_KEY = "sk-test";
process.env.BUDGET_STORE = "memory";
process.env.DAILY_LIMIT_USD = "0.05";
process.env.MONTHLY_LIMIT_USD = "10";

const { GET, POST } = await import("../api/claude.js");
const { resetMemoryStore } = await import("../api/_lib/budget.js");

const realFetch = globalThis.fetch;
let upstreamCalls: { url: string; init: RequestInit }[] = [];

function sseBody(inTok: number, outTok: number): string {
  const ev = [
    { type: "message_start", message: { usage: { input_tokens: inTok, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outTok } },
    { type: "message_stop" },
  ];
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

beforeEach(() => {
  resetMemoryStore();
  upstreamCalls = [];
  globalThis.fetch = (async (url: any, init: any) => {
    upstreamCalls.push({ url: String(url), init });
    return new Response(sseBody(1000, 2000), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (body: unknown, token = "secret-token") =>
  POST(new Request("http://x/api/claude", { method: "POST", headers: { "x-app-token": token, "content-type": "application/json" }, body: JSON.stringify(body) }));

const good = { model: "claude-sonnet-5-5", max_tokens: 1000, stream: true, messages: [{ role: "user", content: "привіт" }] };

test("без токена або з хибним токеном: 401 і жодного виклику до Anthropic", async () => {
  assert.equal((await call(good, "wrong")).status, 401);
  assert.equal((await GET(new Request("http://x/api/claude"))).status, 401);
  assert.equal(upstreamCalls.length, 0);
});

test("модель поза білим списком і завеликий max_tokens відхиляються", async () => {
  assert.equal((await call({ ...good, model: "claude-unknown" })).status, 400);
  assert.equal((await call({ ...good, max_tokens: 999_999 })).status, 400);
  assert.equal((await call({ ...good, messages: [] })).status, 400);
  assert.equal(upstreamCalls.length, 0);
});

test("стрім проходить без змін; ключ додається на сервері; токен застосунку не пересилається", async () => {
  const res = await call(good);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), sseBody(1000, 2000));
  assert.equal(upstreamCalls.length, 1);
  const h = upstreamCalls[0].init.headers as Record<string, string>;
  assert.equal(h["x-api-key"], "sk-test");
  assert.equal(h["x-app-token"], undefined);
  assert.equal(upstreamCalls[0].url, "https://api.anthropic.com/v1/messages");
});

test("витрати рахуються зі стріму і блокують запити після ліміту", async () => {
  // 1000 вх × $2 + 2000 вих × $10 = $0.022 за запит; ліміт на день $0.05
  await (await call(good)).text();
  await (await call(good)).text();
  const status = await (await GET(new Request("http://x/api/claude", { headers: { "x-app-token": "secret-token" } }))).json();
  assert.ok(Math.abs(status.spent.dayUsd - 0.044) < 1e-6, `витрачено ${status.spent.dayUsd}`);
  const blocked = await call(good);
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.error.type, "budget_exceeded");
  assert.equal(upstreamCalls.length, 2, "третій запит не має дійти до Anthropic");
});

test("помилки Anthropic віддаються клієнту і не тарифікуються", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { type: "overloaded_error", message: "busy" } }), { status: 529 })) as typeof fetch;
  const res = await call(good);
  assert.equal(res.status, 529);
  const status = await (await GET(new Request("http://x/api/claude", { headers: { "x-app-token": "secret-token" } }))).json();
  assert.equal(status.spent.dayUsd, 0);
});

test("обрив клієнтом: витрати все одно враховуються", async () => {
  const res = await call(good);
  const reader = res.body!.getReader();
  await reader.read(); // прочитали початок і відключилися
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 20));
  const status = await (await GET(new Request("http://x/api/claude", { headers: { "x-app-token": "secret-token" } }))).json();
  assert.ok(status.spent.dayUsd > 0, "витрати мають бути записані");
});
