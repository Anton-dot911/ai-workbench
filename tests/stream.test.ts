import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageTracker } from "../api/_lib/usage.js";
import { parseSSE } from "../src/core/sse.js";

const sse = (events: object[]): string => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const SAMPLE = sse([
  { type: "message_start", message: { usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 40 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Привіт" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", світе" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 33 } },
  { type: "message_stop" },
]);

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

test("parseSSE склеює події, розірвані між чанками (навіть посеред UTF-8)", async () => {
  for (const size of [1, 3, 7, 64, 10_000]) {
    const events: { event: string; data: string }[] = [];
    for await (const e of parseSSE(chunked(SAMPLE, size))) events.push(e);
    assert.equal(events.length, 7, `розмір чанка ${size}`);
    assert.equal(events[0].event, "message_start");
    assert.equal(JSON.parse(events[2].data).delta.text, "Привіт");
  }
});

test("UsageTracker бере вхід із message_start і вихід із message_delta", () => {
  const t = new UsageTracker();
  const bytes = new TextEncoder().encode(SAMPLE);
  for (let i = 0; i < bytes.length; i += 5) t.push(bytes.slice(i, i + 5));
  const u = t.result();
  assert.equal(u.input_tokens, 120);
  assert.equal(u.cache_read_input_tokens, 40);
  assert.equal(u.output_tokens, 33);
});

test("при обриві без message_delta вихід оцінюється з символів", () => {
  const partial = sse([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(300) } },
  ]);
  const t = new UsageTracker();
  t.push(new TextEncoder().encode(partial));
  assert.equal(t.result().output_tokens, 100);
});
