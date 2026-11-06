import assert from "node:assert/strict";
import { test } from "node:test";
import { costUsd, resolvePrices } from "../shared/pricing.js";

test("Sonnet 5.5: $2 вхід і $10 вихід за 1 млн", () => {
  assert.equal(costUsd("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 12);
});

test("кеш: читання і запис тарифікуються окремо", () => {
  const usd = costUsd("claude-sonnet-5-5", {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  });
  assert.ok(Math.abs(usd - (0.1 + 2.5)) < 1e-9);
});

test("Haiku 5.5: понад 100K токенів діє дорожчий тариф", () => {
  const short = costUsd("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 0 });
  const long = costUsd("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 0 });
  assert.ok(Math.abs(short - 0.01) < 1e-9);
  assert.ok(long > 0.05, `очікувалось ≈0.05, є ${long}`);
});

test("веб-пошук коштує $0.01 за запит", () => {
  const usd = costUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } });
  assert.ok(Math.abs(usd - 0.03) < 1e-9);
});

test("невідома модель викликає помилку", () => {
  assert.throws(() => costUsd("gpt-x", { input_tokens: 1, output_tokens: 1 }), /Невідома модель/);
});

test("PRICES_JSON перевизначає і валідує ціни", () => {
  const t = resolvePrices('{"claude-sonnet-5-5":{"in":1,"out":2,"cacheRead":0.1,"cacheWrite":1.25}}');
  assert.equal(t["claude-sonnet-5-5"].out, 2);
  assert.ok(t["claude-opus-5-5"]);
  assert.throws(() => resolvePrices('{"m":{"in":"x"}}'), /некоректні ціни/);
  assert.throws(() => resolvePrices("{"), /некоректний JSON/);
});
