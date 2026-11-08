import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { AGENTS, parseCommand } from "../src/agents/registry.js";
import { parsePosts, parseReview, reviewToEdits, summarizeOutput } from "../src/agents/outputs.js";
import { checkVariant, normalizeTag, PLATFORMS, postLength, rulesForPrompt } from "../src/agents/platforms.js";
import { postsAgent } from "../src/agents/posts.js";
import { reviewAgent } from "../src/agents/review.js";
import { buildRequest, runAgent } from "../src/core/runner.js";
import { resolveContext } from "../src/core/contextBuilder.js";
import { setSession } from "../src/core/session.js";
import { db } from "../src/db/db.js";
import { TOOL_HANDLERS } from "../src/tools/handlers.js";

const ctx = (n: number, name: string) => ({ calls: { [name]: n }, ui: {} });

beforeEach(async () => {
  await Promise.all([db.runs.clear(), db.artifacts.clear(), db.memory.clear(), db.profile.clear()]);
  setSession({ frag: "", task: "" });
});

// ---------- платформи ----------
test("довжина поста: символи Unicode (емодзі = 1) плюс хештеги через два символи", () => {
  assert.equal(postLength("Привіт 😀", []), 8);
  assert.equal(postLength("Текст", ["#a", "#b"]), 5 + 2 + 5);
});

test("checkVariant: перевищення ліміту й кількість хештегів за правилами платформи", () => {
  const x = checkVariant("x", "а".repeat(300), ["#a", "#b", "#c"]);
  assert.equal(x.over, 20 + 2 + 8);
  assert.match(x.tagIssue!, /хештегів 3, для X потрібно 0–2/);
  const li = checkVariant("linkedin", "ок", ["#a"]);
  assert.equal(li.over, 0);
  assert.match(li.tagIssue!, /для LinkedIn потрібно 3–5/);
  assert.equal(checkVariant("telegram", "ок", ["#a", "#b"]).tagIssue, undefined);
});

test("правила платформ потрапляють у промпт із даних; нормалізація хештегів", () => {
  const r = rulesForPrompt();
  for (const p of Object.values(PLATFORMS)) assert.ok(r.includes(p.name));
  assert.match(r, /210 символів/);
  assert.equal(normalizeTag(" ##my tag "), "#mytag");
  assert.match(postsAgent.systemPrompt, /до 280 символів/);
});

// ---------- submit_posts ----------
test("submit_posts: перше порушення повертається моделі з цифрами, друге приймається з позначкою", async () => {
  const input = { platform: "x", variants: [{ text: "а".repeat(300), hashtags: ["ai"] }, { text: "Коротко", hashtags: ["#a", "b"] }] };
  const first = await TOOL_HANDLERS.submit_posts.run(input, ctx(1, "submit_posts"));
  assert.equal(first.isError, true);
  assert.match(first.content, /варіант 1: 305 символів із 280/);
  const second = await TOOL_HANDLERS.submit_posts.run(input, ctx(2, "submit_posts"));
  assert.equal(second.isError, undefined);
  const out = parsePosts(second.content)!;
  assert.equal(out.variants[0].over, 25);
  assert.deepEqual(out.variants[1].hashtags, ["#a", "#b"]);
  assert.equal(out.variants[1].over, undefined);
});

test("submit_posts: коректний вихід проходить одразу; хештеги нормалізуються й не дублюються", async () => {
  const out = await TOOL_HANDLERS.submit_posts.run({ platform: "telegram", variants: [{ text: "Пост", hashtags: ["ai", "#ai", " ai "] }] }, ctx(1, "submit_posts"));
  assert.equal(out.isError, undefined);
  assert.deepEqual(parsePosts(out.content)!.variants[0].hashtags, ["#ai"]);
  await assert.rejects(() => TOOL_HANDLERS.submit_posts.run({ platform: "myspace", variants: [{ text: "x" }] }, ctx(1, "submit_posts")));
});

// ---------- submit_review ----------
const issue = (over: object = {}) => ({ severity: "medium", category: "language", quote: "у рамках", problem: "калька", suggestion: "у межах", ...over });

test("submit_review: цитата не знайдена → помилка, вдруге заміна прибирається", async () => {
  setSession({ frag: "Текст у рамках проєкту." });
  const input = { verdict: "needs_changes", score: 6, summary: "Є калька", issues: [issue({ replacement: "у межах" }), issue({ quote: "немає такої цитати", replacement: "x" })] };
  const first = await TOOL_HANDLERS.submit_review.run(input, ctx(1, "submit_review"));
  assert.equal(first.isError, true);
  assert.match(first.content, /№2/);
  const second = await TOOL_HANDLERS.submit_review.run(input, ctx(2, "submit_review"));
  const r = parseReview(second.content)!;
  assert.equal(r.issues[0].replacement, "у межах");
  assert.equal(r.issues[1].replacement, undefined);
});

test("submit_review: вердикт обчислюється з серйозності; low не блокує", async () => {
  setSession({ frag: "" });
  const low = await TOOL_HANDLERS.submit_review.run({ verdict: "needs_changes", score: 9, summary: "ок", issues: [issue({ severity: "low" })] }, ctx(1, "submit_review"));
  assert.equal(parseReview(low.content)!.verdict, "ok");
  const high = await TOOL_HANDLERS.submit_review.run({ verdict: "ok", score: 3, summary: "погано", issues: [issue({ severity: "high" })] }, ctx(1, "submit_review"));
  assert.equal(parseReview(high.content)!.verdict, "needs_changes");
  await assert.rejects(() => TOOL_HANDLERS.submit_review.run({ verdict: "ok", score: 11, summary: "x", issues: [] }, ctx(1, "submit_review")));
});

test("reviewToEdits бере лише зауваження з готовою заміною; summarizeOutput", () => {
  const issues = [issue({ replacement: "у межах" }), issue({ quote: "інше" })] as any;
  assert.deepEqual(reviewToEdits(issues), [{ find: "у рамках", replace: "у межах", reason: "калька" }]);
  assert.match(summarizeOutput("review", JSON.stringify({ verdict: "needs_changes", score: 7, summary: "С", issues: [] })), /потрібні правки, 7\/10/);
  assert.equal(summarizeOutput("docs", "текст"), "текст");
});

// ---------- маніфести й реєстр ----------
test("маніфести: унікальні команди, завершальний інструмент є серед інструментів, запит примушує його", async () => {
  const cmds = AGENTS.flatMap((a) => a.commands);
  assert.equal(new Set(cmds).size, cmds.length);
  for (const a of [reviewAgent, postsAgent]) {
    assert.ok(a.finalTool && a.tools.some((t) => t.name === a.finalTool));
    const { packet } = await resolveContext(a, { input: "x" });
    const req = buildRequest(a, packet, { input: "x" }) as any;
    assert.deepEqual(req.tool_choice, { type: "tool", name: a.finalTool, disable_parallel_tool_use: true });
  }
  assert.equal(parseCommand("/перевір language")!.agent.id, "review");
  assert.equal(parseCommand("/пост linkedin: тема")!.rest, "linkedin: тема");
  assert.equal(parseCommand("/docs"), null);
});

// ---------- цикл із завершальним інструментом ----------
const sse = (evs: object[]) => evs.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const toolTurn = (name: string, input: unknown, inTok = 200, outTok = 80) => {
  const j = JSON.stringify(input);
  return sse([
    { type: "message_start", message: { usage: { input_tokens: inTok, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_" + name, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: j.slice(0, 15) } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: j.slice(15) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: outTok } },
  ]);
};
let bodies: any[] = [];
const mock = (turns: string[]) => {
  bodies = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(turns[bodies.length - 1], { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
};

test("Перевірка: завершальний інструмент закінчує запуск одним запитом, вихід це JSON", async () => {
  setSession({ frag: "Текст у рамках проєкту." });
  mock([toolTurn("submit_review", { verdict: "needs_changes", score: 7, summary: "Калька", issues: [issue({ replacement: "у межах" })] })]);
  const { run, text, stopReason } = await runAgent(reviewAgent, { input: "language", selection: "Текст у рамках проєкту." }, { token: "t" });
  assert.equal(bodies.length, 1, "після завершального інструмента нового запиту немає");
  assert.equal(bodies[0].tool_choice.name, "submit_review");
  assert.equal(run.steps, 1);
  assert.equal(stopReason, "end_turn");
  const r = parseReview(text)!;
  assert.equal(r.issues[0].replacement, "у межах");
  assert.equal(run.output, text);
  assert.deepEqual(run.toolCalls, [{ name: "submit_review", ok: true }]);
});

test("Пости: перевищення ліміту → автоповтор у циклі → у підсумку коректний пост", async () => {
  mock([
    toolTurn("submit_posts", { platform: "x", variants: [{ text: "а".repeat(400), hashtags: [] }] }),
    toolTurn("submit_posts", { platform: "x", variants: [{ text: "Коротка думка про кеш.", hashtags: ["ai"] }, { text: "Ще одна.", hashtags: [] }] }),
  ]);
  const { run, text } = await runAgent(postsAgent, { input: "x: про кеш" }, { token: "t" });
  assert.equal(bodies.length, 2);
  const retry = bodies[1].messages.at(-1).content[0];
  assert.equal(retry.is_error, true);
  assert.match(retry.content, /400 символів із 280/);
  const out = parsePosts(text)!;
  assert.equal(out.variants.length, 2);
  assert.equal(out.variants.every((v) => !v.over), true);
  assert.deepEqual(run.toolCalls, [{ name: "submit_posts", ok: false }, { name: "submit_posts", ok: true }]);
  assert.equal(run.usage.input, 400);
});

test("Пости: якщо модель і вдруге перевищує ліміт, результат приймається з позначкою over", async () => {
  const bad = toolTurn("submit_posts", { platform: "x", variants: [{ text: "а".repeat(400), hashtags: [] }] });
  mock([bad, bad]);
  const { text } = await runAgent(postsAgent, { input: "x" }, { token: "t" });
  assert.equal(bodies.length, 2);
  assert.equal(parsePosts(text)!.variants[0].over, 120);
});
