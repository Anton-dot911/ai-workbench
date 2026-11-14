import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { AGENTS } from "../src/agents/registry.js";
import { docsAgent } from "../src/agents/docs.js";
import { reviewAgent } from "../src/agents/review.js";
import { streamMessage } from "../src/core/claude.js";
import { resolveContext } from "../src/core/contextBuilder.js";
import { buildRequest, MAX_STEPS, runAgent } from "../src/core/runner.js";
import { setSession } from "../src/core/session.js";
import { db } from "../src/db/db.js";

// T3c.7d: регресійні тести протоколу Claude Messages API.
// Покривають: streamed thinking (зокрема порожній/прихований із signature), round-trip блоків асистента,
// tool_choice: auto, відсутність temperature і повтор finalTool.

type Ev = Record<string, unknown>;
const sse = (evs: Ev[]) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const start = (inTok = 100) => ({ type: "message_start", message: { usage: { input_tokens: inTok, output_tokens: 1 } } });
const end = (stop: string, outTok = 10): Ev[] => [{ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: outTok } }, { type: "message_stop" }];

const textBlock = (index: number, text: string): Ev[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index },
];
const toolBlock = (index: number, id: string, name: string, input: unknown): Ev[] => {
  const j = JSON.stringify(input);
  return [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j.slice(0, 9) } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j.slice(9) } },
    { type: "content_block_stop", index },
  ];
};
/** Thinking, який приходить частинами: thinking_delta + signature_delta. */
const thinkingBlock = (index: number, parts: string[], sig: string[]): Ev[] => [
  { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
  ...parts.map((t) => ({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: t } })),
  ...sig.map((s) => ({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: s } })),
  { type: "content_block_stop", index },
];
/** Прихований thinking: без thinking_delta, лише signature_delta. */
const hiddenThinking = (index: number, sig: string, withField = true): Ev[] => [
  { type: "content_block_start", index, content_block: withField ? { type: "thinking", thinking: "" } : { type: "thinking" } },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature: sig } },
  { type: "content_block_stop", index },
];

let bodies: any[] = [];
function mock(turns: string[] | ((n: number) => string)) {
  bodies = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const n = bodies.length - 1;
    return new Response(typeof turns === "function" ? turns(n) : turns[n], { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

const baseReq = { model: "m", max_tokens: 100, messages: [{ role: "user" as const, content: "x" }] };

beforeEach(async () => {
  await Promise.all([db.runs.clear(), db.artifacts.clear(), db.memory.clear(), db.profile.clear()]);
  setSession({ frag: "У рамках проєкту.", task: "" });
});

// ---------- SSE: thinking ----------
test("SSE: thinking і signature накопичуються з частин у одному блоці, порядок блоків зберігається", async () => {
  mock([sse([start(), ...thinkingBlock(0, ["Спершу ", "подумаю."], ["EuYB", "Cko="]), ...textBlock(1, "Відповідь."), ...end("end_turn")])]);
  const r = await streamMessage(baseReq, { token: "t" });
  assert.deepEqual(r.content.map((b) => b.type), ["thinking", "text"]);
  assert.equal(r.content[0].thinking, "Спершу подумаю.");
  assert.equal(r.content[0].signature, "EuYBCko=");
  assert.equal(r.text, "Відповідь.", "thinking не потрапляє у видимий текст");
});

test("SSE: прихований thinking (лише signature_delta) зберігає signature і має рядок thinking", async () => {
  mock([sse([start(), ...hiddenThinking(0, "SIG123"), ...textBlock(1, "ok"), ...end("end_turn")])]);
  const r = await streamMessage(baseReq, { token: "t" });
  assert.equal(r.content[0].type, "thinking");
  assert.equal(r.content[0].thinking, "");
  assert.equal(r.content[0].signature, "SIG123");
});

test("SSE: якщо в content_block_start немає поля thinking, у блоці воно все одно є рядком (API вимагає поле)", async () => {
  mock([sse([start(), ...hiddenThinking(0, "SIG456", false), ...textBlock(1, "ok"), ...end("end_turn")])]);
  const r = await streamMessage(baseReq, { token: "t" });
  assert.equal(typeof r.content[0].thinking, "string");
  assert.equal(r.content[0].signature, "SIG456");
});

test("SSE: redacted_thinking зберігається без змін (data), текст не підробляється", async () => {
  mock([
    sse([
      start(),
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "ENC==" } },
      { type: "content_block_stop", index: 0 },
      ...textBlock(1, "ok"),
      ...end("end_turn"),
    ]),
  ]);
  const r = await streamMessage(baseReq, { token: "t" });
  assert.deepEqual(r.content[0], { type: "redacted_thinking", data: "ENC==" });
});

test("SSE: signature не синтезується, якщо її не було в потоці", async () => {
  mock([sse([start(), ...thinkingBlock(0, ["думка"], []), ...textBlock(1, "ok"), ...end("end_turn")])]);
  const r = await streamMessage(baseReq, { token: "t" });
  assert.equal("signature" in r.content[0], false);
});

// ---------- round-trip у циклі ----------
const edit = { target: "selection", edits: [{ find: "У рамках", replace: "У межах" }] };

test("round-trip: thinking із signature повертається в наступному запиті без змін і перед tool_use", async () => {
  mock([
    sse([start(), ...thinkingBlock(0, ["План ", "правки."], ["AAA", "BBB"]), ...textBlock(1, "Виправляю."), ...toolBlock(2, "toolu_1", "apply_edits", edit), ...end("tool_use")]),
    sse([start(), ...textBlock(0, "Готово."), ...end("end_turn")]),
  ]);
  await runAgent(docsAgent, { input: "виправ", selection: "У рамках проєкту." }, { token: "t", confirm: async () => ({ approve: true }) });
  assert.equal(bodies.length, 2);
  const asst = bodies[1].messages[1];
  assert.equal(asst.role, "assistant");
  assert.deepEqual(asst.content[0], { type: "thinking", thinking: "План правки.", signature: "AAABBB" });
  assert.deepEqual(asst.content.map((b: any) => b.type), ["thinking", "text", "tool_use"]);
  assert.deepEqual(asst.content[2].input, edit, "tool-use JSON зібрано з частин і повернуто структурно");
  const res = bodies[1].messages[2];
  assert.equal(res.role, "user");
  assert.equal(res.content[0].type, "tool_result");
  assert.equal(res.content[0].tool_use_id, "toolu_1");
});

test("round-trip: порожній текстовий блок відкидається, але прихований thinking із signature лишається", async () => {
  mock([
    sse([
      start(),
      ...hiddenThinking(0, "HID"),
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_stop", index: 1 },
      ...toolBlock(2, "toolu_2", "apply_edits", edit),
      ...end("tool_use"),
    ]),
    sse([start(), ...textBlock(0, "Готово."), ...end("end_turn")]),
  ]);
  await runAgent(docsAgent, { input: "виправ", selection: "У рамках проєкту." }, { token: "t", confirm: async () => ({ approve: true }) });
  const asst = bodies[1].messages[1];
  assert.deepEqual(asst.content.map((b: any) => b.type), ["thinking", "tool_use"]);
  assert.equal(asst.content[0].signature, "HID");
  assert.equal(typeof asst.content[0].thinking, "string");
});

test("round-trip: відхилена зміна повертається моделі як tool_result з is_error", async () => {
  mock([
    sse([start(), ...thinkingBlock(0, ["x"], ["S"]), ...toolBlock(1, "toolu_3", "apply_edits", edit), ...end("tool_use")]),
    sse([start(), ...textBlock(0, "Зрозуміло."), ...end("end_turn")]),
  ]);
  await runAgent(docsAgent, { input: "виправ", selection: "У рамках проєкту." }, { token: "t", confirm: async () => ({ approve: false }) });
  const r = bodies[1].messages[2].content[0];
  assert.equal(r.is_error, true);
  assert.equal(r.tool_use_id, "toolu_3");
});

// ---------- параметри запиту ----------
test("запити: жодного temperature і жодного tool_choice типу tool/any для всіх агентів", async () => {
  for (const a of AGENTS) {
    const { packet } = await resolveContext(a, { input: "x" });
    const req = buildRequest(a, packet, { input: "x" }) as Record<string, any>;
    assert.equal("temperature" in req, false, `${a.id}: temperature`);
    assert.equal("thinking" in req, false, `${a.id}: thinking не вмикається без перевірки моделі`);
    if (a.finalTool) {
      assert.equal(req.tool_choice.type, "auto", `${a.id}: tool_choice`);
    } else {
      assert.ok(!req.tool_choice || !["tool", "any"].includes(req.tool_choice.type), `${a.id}: tool_choice`);
    }
  }
});

test("запити: у реальному тілі fetch немає temperature, а stream увімкнено", async () => {
  mock([sse([start(), ...textBlock(0, "ok"), ...end("end_turn")])]);
  await runAgent(docsAgent, { input: "привіт" }, { token: "t" });
  assert.equal("temperature" in bodies[0], false);
  assert.equal(bodies[0].stream, true);
});

// ---------- повтор finalTool ----------
const review = { verdict: "ok", score: 9, summary: "Добре", issues: [] };

test("finalTool: відповідь текстом без інструмента → один додатковий запит із нагадуванням, потім успіх", async () => {
  mock([
    sse([start(), ...thinkingBlock(0, ["думаю"], ["SG"]), ...textBlock(1, "Усе гаразд."), ...end("end_turn")]),
    sse([start(), ...toolBlock(0, "toolu_r", "submit_review", review), ...end("tool_use")]),
  ]);
  const { run, stopReason } = await runAgent(reviewAgent, { input: "language", selection: "Текст." }, { token: "t" });
  assert.equal(bodies.length, 2);
  assert.equal(run.steps, 2);
  assert.equal(stopReason, "end_turn");
  assert.deepEqual(run.toolCalls, [{ name: "submit_review", ok: true }]);
  const [, asst, nudge] = bodies[1].messages;
  assert.equal(asst.role, "assistant");
  assert.deepEqual(asst.content.map((b: any) => b.type), ["thinking", "text"], "thinking із signature зберігається в повторі");
  assert.equal(asst.content[0].signature, "SG");
  assert.equal(nudge.role, "user");
  assert.match(nudge.content, /submit_review/);
  assert.deepEqual(bodies[1].tool_choice, { type: "auto", disable_parallel_tool_use: true });
});

test("finalTool: після успішного виклику повторних запитів немає", async () => {
  mock([sse([start(), ...toolBlock(0, "toolu_r", "submit_review", review), ...end("tool_use")])]);
  const { run } = await runAgent(reviewAgent, { input: "language", selection: "Текст." }, { token: "t" });
  assert.equal(bodies.length, 1);
  assert.equal(run.steps, 1);
});

test("finalTool: модель ніколи не викликає інструмент → зупинка на MAX_STEPS із зрозумілою помилкою", async () => {
  mock(() => sse([start(), ...textBlock(0, "Лише текст."), ...end("end_turn")]));
  await assert.rejects(runAgent(reviewAgent, { input: "language", selection: "Текст." }, { token: "t" }), /submit_review/);
  assert.equal(bodies.length, MAX_STEPS);
});

test("finalTool: інший інструмент не підміняє завершальний (запуск продовжується)", async () => {
  mock([
    sse([start(), ...toolBlock(0, "toolu_s", "search_context", { query: "стиль" }), ...end("tool_use")]),
    sse([start(), ...toolBlock(0, "toolu_r", "submit_review", review), ...end("tool_use")]),
  ]);
  const { run } = await runAgent(reviewAgent, { input: "language", selection: "Текст." }, { token: "t" });
  assert.equal(bodies.length, 2);
  assert.deepEqual(run.toolCalls!.map((c) => c.name), ["search_context", "submit_review"]);
});
