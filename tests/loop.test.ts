import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { docsAgent } from "../src/agents/docs.js";
import { MAX_STEPS, runAgent } from "../src/core/runner.js";
import { getSession, setSession } from "../src/core/session.js";
import { db } from "../src/db/db.js";

type Ev = Record<string, unknown>;
const sse = (evs: Ev[]) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** Хід моделі: необов'язковий текст і необов'язковий виклик інструмента. */
function turn(o: { text?: string; tool?: { id: string; name: string; input: unknown }; inTok?: number; outTok?: number }): string {
  const ev: Ev[] = [{ type: "message_start", message: { usage: { input_tokens: o.inTok ?? 100, output_tokens: 1 } } }];
  let idx = 0;
  if (o.text) {
    ev.push({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
    ev.push({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: o.text } });
    ev.push({ type: "content_block_stop", index: idx++ });
  }
  if (o.tool) {
    const json = JSON.stringify(o.tool.input);
    ev.push({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: o.tool.id, name: o.tool.name, input: {} } });
    ev.push({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: json.slice(0, 10) } });
    ev.push({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: json.slice(10) } });
    ev.push({ type: "content_block_stop", index: idx });
  }
  ev.push({ type: "message_delta", delta: { stop_reason: o.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: o.outTok ?? 10 } });
  ev.push({ type: "message_stop" });
  return sse(ev);
}

let bodies: any[] = [];
function mockModel(turns: string[] | ((n: number) => string)) {
  bodies = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const n = bodies.length - 1;
    const body = typeof turns === "function" ? turns(n) : turns[n];
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

const editCall = (edits: unknown[], id = "toolu_1") => ({ id, name: "apply_edits", input: { target: "selection", edits } });
const lastUser = () => bodies.at(-1).messages.at(-1).content;

beforeEach(async () => {
  await Promise.all([db.runs.clear(), db.artifacts.clear(), db.memory.clear(), db.profile.clear()]);
  setSession({ frag: "У рамках проєкту. Даний документ описує план.", task: "" });
});

test("цикл: інструмент → підтвердження → результат → відповідь; usage сумується, текст склеюється", async () => {
  mockModel([
    turn({ text: "Виправляю.", tool: editCall([{ find: "У рамках", replace: "У межах" }, { find: "Даний документ", replace: "Документ" }]), inTok: 100, outTok: 30 }),
    turn({ text: "Готово: замінено два звороти.", inTok: 150, outTok: 20 }),
  ]);
  const events: string[] = [];
  let seen: any;
  const streamed: string[] = [];
  const { run, text, stopReason } = await runAgent(docsAgent, { input: "виправ калькі", selection: getSession().frag }, {
    token: "t",
    onText: (d) => streamed.push(d),
    onTool: (e) => events.push(`${e.name}:${e.status}`),
    confirm: async (r) => ((seen = r), { approve: true }),
  });

  assert.equal(bodies.length, 2);
  assert.equal(getSession().frag, "У межах проєкту. Документ описує план.");
  assert.equal(seen.edits.length, 2);
  assert.deepEqual(events, ["apply_edits:start", "apply_edits:ok"]);
  assert.equal(text, "Виправляю.\n\nГотово: замінено два звороти.");
  assert.equal(streamed.join(""), text, "потік тексту збігається з підсумком");
  assert.equal(stopReason, "end_turn");
  assert.equal(run.steps, 2);
  assert.equal(run.usage.input, 250);
  assert.equal(run.usage.output, 50);
  assert.deepEqual(run.toolCalls, [{ name: "apply_edits", ok: true }]);
  assert.ok(run.usage.costUsd > 0);
  assert.equal((await db.runs.count()), 1);

  // другий запит містить assistant(tool_use) і user(tool_result) з тим самим id
  const second = bodies[1].messages;
  assert.equal(second.at(-2).role, "assistant");
  assert.equal(second.at(-2).content.find((b: any) => b.type === "tool_use").id, "toolu_1");
  assert.equal(second.at(-1).content[0].type, "tool_result");
  assert.equal(second.at(-1).content[0].tool_use_id, "toolu_1");
  assert.equal(bodies[0].tools.length, 5, "інструменти агента передаються в запиті");
});

test("користувач відхилив зміну → tool_result з is_error, фрагмент не змінено", async () => {
  mockModel([turn({ tool: editCall([{ find: "У рамках", replace: "У межах" }]) }), turn({ text: "Зрозуміло, не змінюю." })]);
  const { run } = await runAgent(docsAgent, { input: "x" }, { token: "t", confirm: async () => ({ approve: false }) });
  assert.equal(getSession().frag, "У рамках проєкту. Даний документ описує план.");
  assert.equal(lastUser()[0].is_error, true);
  assert.match(lastUser()[0].content, /відхилив/);
  assert.deepEqual(run.toolCalls, [{ name: "apply_edits", ok: false }]);
});

test("часткове прийняття правок: застосовується лише вибране", async () => {
  mockModel([turn({ tool: editCall([{ find: "У рамках", replace: "У межах" }, { find: "Даний документ", replace: "Документ" }]) }), turn({ text: "ok" })]);
  await runAgent(docsAgent, { input: "x" }, { token: "t", confirm: async () => ({ approve: true, accepted: [1] }) });
  assert.equal(getSession().frag, "У рамках проєкту. Документ описує план.");
  assert.match(lastUser()[0].content, /Застосовано правок: 1 з 2/);
  assert.match(lastUser()[0].content, /відхилив: 1/);
});

test("хибні правки повертаються моделі без підтвердження", async () => {
  mockModel([turn({ tool: editCall([{ find: "немає такого", replace: "x" }]) }), turn({ text: "Спробую інакше." })]);
  let confirmCalled = false;
  await runAgent(docsAgent, { input: "x" }, { token: "t", confirm: async () => ((confirmCalled = true), { approve: true }) });
  assert.equal(confirmCalled, false);
  assert.equal(lastUser()[0].is_error, true);
  assert.match(lastUser()[0].content, /не знайдено/);
});

test("ask_user: відповідь користувача йде в tool_result", async () => {
  mockModel([turn({ tool: { id: "toolu_q", name: "ask_user", input: { question: "Для кого текст?" } } }), turn({ text: "Дякую." })]);
  let q = "";
  await runAgent(docsAgent, { input: "x" }, { token: "t", ask: async (r) => ((q = r.question), "для клієнтів") });
  assert.equal(q, "Для кого текст?");
  assert.equal(lastUser()[0].content, "для клієнтів");
});

test("невідомий інструмент і помилка валідації не валять цикл", async () => {
  mockModel([
    turn({ tool: { id: "t1", name: "format_disk", input: {} } }),
    turn({ tool: { id: "t2", name: "apply_edits", input: { target: "selection", edits: [] } } }),
    turn({ text: "Гаразд." }),
  ]);
  const { run, text } = await runAgent(docsAgent, { input: "x" }, { token: "t" });
  assert.equal(text, "Гаразд.");
  assert.deepEqual(run.toolCalls, [{ name: "format_disk", ok: false }, { name: "apply_edits", ok: false }]);
});

test("запобіжник: нескінченний цикл зупиняється на MAX_STEPS", async () => {
  mockModel(() => turn({ tool: { id: "loop", name: "search_context", input: { query: "x" } } }));
  await assert.rejects(() => runAgent(docsAgent, { input: "x" }, { token: "t" }), /ліміт кроків/);
  assert.equal(bodies.length, MAX_STEPS);
});

test("зупинка користувачем між кроками", async () => {
  const ac = new AbortController();
  mockModel([turn({ tool: { id: "a", name: "search_context", input: { query: "x" } } }), turn({ text: "не дійде" })]);
  await assert.rejects(
    () => runAgent(docsAgent, { input: "x" }, { token: "t", signal: ac.signal, onTool: (e) => e.status === "ok" && ac.abort() }),
    (e: any) => e.kind === "aborted",
  );
  assert.equal(bodies.length, 1);
});
