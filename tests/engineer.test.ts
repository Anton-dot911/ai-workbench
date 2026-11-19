import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { engineerAgent } from "../src/agents/engineer.js";
import { AGENTS, parseCommand } from "../src/agents/registry.js";
import { MAX_STEPS, MAX_STEPS_HARD, runAgent, type RunUi } from "../src/core/runner.js";
import { setSession } from "../src/core/session.js";
import { db } from "../src/db/db.js";
import { PackageError, transition, type EngineeringPackage } from "../src/engineering/package.js";
import { listPackages, loadPackage, savePackage } from "../src/engineering/store.js";
import { ENGINEERING_TOOL_NAMES, PACKAGE_LIMITS } from "../src/tools/engineering.js";
import { TOOL_HANDLERS } from "../src/tools/handlers.js";

// T5.2: агент «Інженер». Модель підміняється потоками SSE; перевіряється, що пакет будується інструментами,
// код повертає моделі проблеми, зафіксований пакет не змінюється, а затвердити його агент не може.

type Ev = Record<string, unknown>;
const sse = (evs: Ev[]) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const start = (): Ev => ({ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } });
const end = (stop: string, outTok = 100): Ev[] => [{ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: outTok } }, { type: "message_stop" }];
const toolBlock = (index: number, id: string, name: string, input: unknown): Ev[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index },
];
const tool = (name: string, input: unknown, id = `toolu_${name}`): string => sse([start(), ...toolBlock(0, id, name, input), ...end("tool_use")]);
const answer = (text: string): string => sse([start(), { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, { type: "content_block_stop", index: 0 }, ...end("end_turn")]);

let bodies: any[] = [];
function mock(turns: string[] | ((n: number) => string)) {
  bodies = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const n = bodies.length - 1;
    const t = typeof turns === "function" ? turns(n) : turns[n];
    if (t === undefined) throw new Error("несподіваний додатковий запит");
    return new Response(t, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}
/** Результат інструмента, який отримала модель у запиті з номером n (останній tool_result). */
const toolResult = (n: number): { content: string; is_error?: boolean } => {
  const msgs = bodies[n].messages;
  const last = msgs.at(-1);
  return last.content.find((b: any) => b.type === "tool_result");
};
const resultJson = (n: number) => JSON.parse(toolResult(n).content);
const ui = (extra: Partial<RunUi> = {}): RunUi => ({ token: "t", confirmHandoff: async () => true, ...extra });

const REQS = [
  { id: "REQ-001", title: "Імпорт лише додає", description: "Не видаляє й не перезаписує наявні записи.", priority: "must", kind: "confirmed", acceptance: [{ text: "Наявні факти після імпорту не змінились", verification: "test" }] },
  { id: "REQ-002", title: "Без дублів", description: "Повторний імпорт нічого не додає.", priority: "must", kind: "confirmed", acceptance: [{ text: "Другий імпорт додає 0 записів", verification: "test" }] },
];
const COMPS = [
  { id: "COMP-001", name: "Схема імпорту", purpose: "Перевіряє форму файлу.", responsibilities: ["Відхиляти невалідні записи"], inputs: ["JSON"], outputs: ["Перевірені записи"], dependsOn: [], errors: ["Невалідний JSON"] },
  { id: "COMP-002", name: "Імпортер", purpose: "Додає записи.", responsibilities: ["Пропускати дублі"], inputs: ["Перевірені записи"], outputs: ["Звіт імпорту"], dependsOn: ["COMP-001"], errors: [] },
];
const ENTS = [{ id: "ENT-001", name: "MemoryItem", description: "Факт пам'яті", fields: [{ name: "id", type: "string", required: true }, { name: "text", type: "string", required: true }], relations: [] }];
const TASKS = [
  { id: "TASK-001", title: "Схема файлу імпорту", description: "zod-схема.", requirements: ["REQ-001"], components: ["COMP-001"], dependsOn: [], files: ["src/db/importexport.ts"], acceptance: ["Невалідний запис відхиляється"], verification: "npm run check" },
  { id: "TASK-002", title: "Додавання без дублів", description: "Додає відсутні записи.", requirements: ["REQ-001", "REQ-002"], components: ["COMP-002"], dependsOn: ["TASK-001"], files: ["src/db/importexport.ts"], acceptance: ["Повторний імпорт додає 0"], verification: "tests/importexport.test.ts" },
];
const ARCH = "Імпорт читає файл експорту, перевіряє схемою й додає лише відсутні записи в Dexie.";

beforeEach(async () => {
  await Promise.all([db.runs.clear(), db.artifacts.clear(), db.memory.clear(), db.profile.clear(), db.proposals.clear()]);
  setSession({ frag: "", task: "" });
});

/** Створює пакет напряму (як це зробив би create_package) і повертає packageId. */
async function seed(status: "DRAFT" | "REVIEW" = "DRAFT"): Promise<string> {
  const run = await TOOL_HANDLERS.create_package.run({ projectId: "workbench-import", summary: "Імпорт бази: лише додає, без дублів." }, { ui: {} });
  const id = JSON.parse(run.content).packageId as string;
  if (status === "REVIEW") {
    for (const [name, input] of [["set_requirements", { requirements: REQS }], ["set_architecture", { architecture: ARCH, components: COMPS }], ["set_data_model", { entities: ENTS }], ["set_tasks", { tasks: TASKS }]] as const) await TOOL_HANDLERS[name].run({ packageId: id, ...input }, { ui: {} });
    await TOOL_HANDLERS.request_review.run({ packageId: id }, { ui: {} });
  }
  return id;
}

// ---------- маніфест ----------
test("маніфест: агент у реєстрі, команда, інструменти пакета, handoff лише до пошуку, ліміт кроків вищий за типовий", () => {
  assert.ok(AGENTS.includes(engineerAgent));
  assert.equal(parseCommand("/інженер спроєктуй імпорт")?.agent.id, "engineer");
  assert.equal(parseCommand("/engineer x")?.agent.id, "engineer");
  const names = engineerAgent.tools.map((t) => t.name);
  for (const n of ENGINEERING_TOOL_NAMES) assert.ok(names.includes(n), n);
  for (const n of ["search_context", "read_artifact", "ask_user", "handoff"]) assert.ok(names.includes(n), n);
  assert.deepEqual(engineerAgent.handoffTo, ["search"]);
  assert.deepEqual(ENGINEERING_TOOL_NAMES, ["create_package", "set_requirements", "set_architecture", "set_data_model", "set_tasks", "set_open_questions", "check_package", "request_review"]);
  assert.ok(engineerAgent.maxSteps! > MAX_STEPS && engineerAgent.maxSteps! <= MAX_STEPS_HARD);
});

test("межі: агент не має інструмента затвердження, зміни зафіксованого пакета чи довільного збереження артефактів", () => {
  const names = engineerAgent.tools.map((t) => t.name);
  for (const forbidden of ["approve_package", "approve", "save_artifact", "apply_edits", "revise_package", "propose_memory"]) assert.ok(!names.includes(forbidden), forbidden);
  assert.ok(!Object.keys(TOOL_HANDLERS).some((n) => /approve/i.test(n)), "у реєстрі інструментів немає жодного approve");
  assert.match(engineerAgent.systemPrompt, /не затверджуєш пакет/);
  assert.match(engineerAgent.systemPrompt, /<untrusted_content>/);
});

// ---------- наскрізний сценарій ----------
test("наповнення: create → розділи → check → request_review; пакет у REVIEW, не APPROVED, історія записана", async () => {
  // Сценарій із динамічним packageId: кожен хід бере id з попереднього tool_result.
  let pkgId = "";
  const steps: (() => string)[] = [
    () => tool("create_package", { projectId: "workbench-import", summary: "Імпорт бази: лише додає, без дублів (документи @26639e4)." }),
    () => tool("set_requirements", { packageId: pkgId, requirements: REQS }),
    () => tool("set_architecture", { packageId: pkgId, architecture: ARCH, components: COMPS }),
    () => tool("set_data_model", { packageId: pkgId, entities: ENTS }),
    () => tool("set_tasks", { packageId: pkgId, tasks: TASKS }),
    () => tool("check_package", { packageId: pkgId }),
    () => tool("request_review", { packageId: pkgId, note: "Готово до перегляду" }),
    () => answer("Пакет передано на перегляд: 2 вимоги, 2 компоненти, 2 задачі."),
  ];
  mock((n) => {
    // Результат інструмента попереднього кроку приходить у поточному запиті (bodies[n]), а не в попередньому.
    if (n > 0 && !pkgId) {
      const prev = resultJson(n);
      if (prev.packageId) pkgId = prev.packageId;
    }
    return steps[n]();
  });
  const res = await runAgent(engineerAgent, { input: "Спроєктуй модуль імпорту бази" }, ui());

  assert.equal(bodies.length, 8);
  assert.deepEqual(res.run.toolCalls?.map((c) => [c.name, c.ok]), [["create_package", true], ["set_requirements", true], ["set_architecture", true], ["set_data_model", true], ["set_tasks", true], ["check_package", true], ["request_review", true]]);

  const check = resultJson(6);
  assert.equal(check.readyForReview, true);
  assert.equal(check.errors, 0);
  assert.deepEqual(check.counts, { requirements: 2, components: 2, entities: 1, tasks: 2, openQuestions: 0 });

  const pkg = await loadPackage(`${pkgId}@1.0`);
  assert.equal(pkg?.status, "REVIEW");
  assert.equal(pkg?.requirements.length, 2);
  assert.match(pkg!.summary, /@26639e4/);
  assert.deepEqual(pkg!.history.map((h) => h.status), ["DRAFT", "REVIEW"]);
  assert.equal(pkg!.approval, undefined, "затвердження за користувачем");
  assert.equal(res.text, "Пакет передано на перегляд: 2 вимоги, 2 компоненти, 2 задачі.");
  // Зміни чернетки в процесі наповнення збережено в версіях артефакту.
  assert.ok((await db.artifacts.get(`${pkgId}@1.0`))!.versions.length >= 5);
});

// ---------- зворотний зв'язок від коду ----------
test("розділ зберігається разом із проблемами пакета: модель одразу бачить, що виправити", async () => {
  const id = await seed();
  const badTasks = [{ ...TASKS[0], requirements: ["REQ-099"] }, { ...TASKS[1], dependsOn: ["TASK-009"] }];
  const r = await TOOL_HANDLERS.set_tasks.run({ packageId: id, tasks: badTasks }, { ui: {} });
  assert.equal(r.isError, undefined, "семантичні проблеми не відхиляють збереження чернетки");
  const v = JSON.parse(r.content);
  assert.equal(v.saved, "tasks");
  assert.equal(v.count, 2);
  assert.ok(v.errors >= 2);
  assert.ok(v.issues.some((i: string) => /TASK_UNKNOWN_REQUIREMENT TASK-001/.test(i)));
  assert.ok(v.issues.some((i: string) => /TASK_UNKNOWN_DEP TASK-002/.test(i)));
  assert.equal((await listPackages())[0].tasks.length, 2);
});

test("помилкова форма входу відхиляється з поясненням і нічого не зберігає", async () => {
  const id = await seed();
  const r = await TOOL_HANDLERS.set_requirements.run({ packageId: id, requirements: [{ ...REQS[0], id: "REQ-1", priority: "critical" }] }, { ui: {} });
  assert.equal(r.isError, true);
  assert.match(r.content, /Невірний формат[\s\S]*REQ-001/);
  assert.equal((await listPackages())[0].requirements.length, 0);
  const noId = await TOOL_HANDLERS.set_data_model.run({ entities: [] }, { ui: {} });
  assert.equal(noId.isError, true);
  const unknown = await TOOL_HANDLERS.set_data_model.run({ packageId: "nope", entities: [] }, { ui: {} });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /не знайдено/);
});

test("межі розміру розділів: забагато елементів відхиляється", async () => {
  const id = await seed();
  const many = Array.from({ length: PACKAGE_LIMITS.requirements + 1 }, (_, i) => ({ ...REQS[0], id: `REQ-${String(i + 1).padStart(3, "0")}` }));
  const r = await TOOL_HANDLERS.set_requirements.run({ packageId: id, requirements: many }, { ui: {} });
  assert.equal(r.isError, true);
});

test("request_review: неповний пакет відхиляється з причинами, статус лишається DRAFT", async () => {
  const id = await seed();
  await TOOL_HANDLERS.set_requirements.run({ packageId: id, requirements: REQS }, { ui: {} });
  const r = await TOOL_HANDLERS.request_review.run({ packageId: id }, { ui: {} });
  assert.equal(r.isError, true);
  assert.match(r.content, /не готовий/);
  assert.equal((await listPackages())[0].status, "DRAFT");
  const check = JSON.parse((await TOOL_HANDLERS.check_package.run({ packageId: id }, { ui: {} })).content);
  assert.equal(check.readyForReview, false);
  assert.ok(check.issues.some((i: string) => /EMPTY_COMPONENTS/.test(i)));
});

test("блокувальне питання не дає передати пакет на перегляд, доки не вирішене", async () => {
  const id = await seed();
  for (const [name, input] of [["set_requirements", { requirements: REQS }], ["set_architecture", { architecture: ARCH, components: COMPS }], ["set_data_model", { entities: ENTS }], ["set_tasks", { tasks: TASKS }], ["set_open_questions", { questions: [{ id: "Q-001", text: "Чи імпортувати журнал запусків?", blocking: true }] }]] as const) await TOOL_HANDLERS[name].run({ packageId: id, ...input }, { ui: {} });
  const refused = await TOOL_HANDLERS.request_review.run({ packageId: id }, { ui: {} });
  assert.equal(refused.isError, true);
  assert.match(refused.content, /блокувальне/);
  await TOOL_HANDLERS.set_open_questions.run({ packageId: id, questions: [{ id: "Q-001", text: "Чи імпортувати журнал запусків?", blocking: true, resolution: "Ні" }] }, { ui: {} });
  assert.equal((await TOOL_HANDLERS.request_review.run({ packageId: id }, { ui: {} })).isError, undefined);
});

// ---------- незмінність і заборона затвердження ----------
test("після REVIEW агент не може змінити розділи: is_error з поясненням, пакет не зачеплено", async () => {
  const id = await seed("REVIEW");
  const before = JSON.stringify(await loadPackage(`${id}@1.0`));
  for (const [name, input] of [["set_requirements", { requirements: [] }], ["set_tasks", { tasks: [] }], ["set_architecture", { architecture: "Підмінена архітектура.", components: [] }], ["set_open_questions", { questions: [] }]] as const) {
    const r = await TOOL_HANDLERS[name].run({ packageId: id, ...input }, { ui: {} });
    assert.equal(r.isError, true, name);
    assert.match(r.content, /незмінний/, name);
  }
  assert.equal(JSON.stringify(await loadPackage(`${id}@1.0`)), before);
  const again = await TOOL_HANDLERS.request_review.run({ packageId: id }, { ui: {} });
  assert.equal(again.isError, true, "повторно передати на перегляд не можна");
});

test("затвердити пакет може лише користувач: перехід агента в APPROVED кидає помилку, а інструмента для цього немає", async () => {
  const id = await seed("REVIEW");
  const pkg = (await loadPackage(`${id}@1.0`)) as EngineeringPackage;
  assert.throws(() => transition(pkg, "APPROVED", { by: "agent" }), (e: unknown) => e instanceof PackageError && /лише користувач/.test((e as Error).message));
  assert.equal(transition(pkg, "APPROVED", { by: "user" }).status, "APPROVED");
});

test("create_package: другий пакет того ж проєкту відхиляється, чернетку можна продовжити; зафіксований пакет не дублюється", async () => {
  const first = await TOOL_HANDLERS.create_package.run({ projectId: "demo-module", summary: "Перший пакет модуля." }, { ui: {} });
  const second = await TOOL_HANDLERS.create_package.run({ projectId: "demo-module", summary: "Спроба дубліката." }, { ui: {} });
  assert.equal(second.isError, true);
  assert.match(second.content, new RegExp(JSON.parse(first.content).packageId));
  assert.match(second.content, /Продовжуй працювати/);
  const id = await seed("REVIEW");
  const third = await TOOL_HANDLERS.create_package.run({ projectId: "workbench-import", summary: "Ще раз той самий проєкт." }, { ui: {} });
  assert.equal(third.isError, true);
  assert.match(third.content, /зафіксований/);
  assert.ok(id);
  const bad = await TOOL_HANDLERS.create_package.run({ projectId: "Bad Id!", summary: "x" }, { ui: {} });
  assert.equal(bad.isError, true);
});

// ---------- ліміт кроків ----------
test("ліміт кроків: агент «Інженер» дозволяє довгий процес, але не більше свого ліміту", async () => {
  mock(() => tool("check_package", { packageId: "nope" }));
  await assert.rejects(runAgent(engineerAgent, { input: "x" }, ui()), new RegExp(`ліміт кроків \\(${engineerAgent.maxSteps}\\)`));
  assert.equal(bodies.length, engineerAgent.maxSteps);
});

test("ліміт кроків: інші агенти лишаються на типових 12, а значення з маніфеста обмежене верхньою межею", async () => {
  const hard = { ...engineerAgent, maxSteps: 1000 };
  mock(() => tool("check_package", { packageId: "nope" }));
  await assert.rejects(runAgent(hard, { input: "x" }, ui()), /ліміт кроків/);
  assert.equal(bodies.length, MAX_STEPS_HARD);
  assert.equal(MAX_STEPS, 12);
  assert.equal(AGENTS.filter((a) => a.maxSteps !== undefined).map((a) => a.id).join(), "engineer");
});

// ---------- збереження в бібліотеці ----------
test("пакет, створений агентом, видно в «Бібліотеці» як артефакт engineering_package, а не як звичайний документ", async () => {
  const id = await seed();
  const a = await db.artifacts.get(`${id}@1.0`);
  assert.equal(a?.type, "engineering_package");
  assert.match(a!.title, /^Пакет: workbench-import v1\.0 · DRAFT$/);
  const p = await loadPackage(`${id}@1.0`);
  assert.equal(p?.status, "DRAFT");
  await assert.rejects(savePackage({ ...p!, status: "APPROVED" }), /незмінна|неможливий|лише як чернетка/);
});
