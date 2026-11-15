import assert from "node:assert/strict";
import { test } from "node:test";

import { chainTitle, groupRuns, stepLabel } from "../src/core/journal.js";
import type { ChainInfo, Run } from "../src/core/types.js";

const NAMES: Record<string, string> = { search: "Пошук", posts: "Пости", review: "Перевірка", docs: "Документи" };
const nameOf = (id: string) => NAMES[id] ?? id;

let n = 0;
function run(agentId: string, createdAt: number, extra: Partial<Run> = {}): Run {
  return {
    id: `r${++n}`, agentId, input: `вхід ${agentId}`, output: "", createdAt,
    contextSnapshot: { stable: "", relevant: "", operative: "", tokenEstimate: 0, sources: [] },
    usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0.01 },
    ...extra,
  };
}
const info = (index: number): ChainInfo => ({ recipe: "Пост з дослідженням", topic: "x: тема", index, total: 3 });
/** Ланцюг із трьох кроків; записи йдуть від найновішого, як їх віддає журнал. */
const chain3 = (id: string, t0: number, costs = [0.17, 0.02, 0.02]): Run[] =>
  ["search", "posts", "review"].map((a, i) => run(a, t0 + i * 1000, { chainId: id, chain: info(i), usage: { input: 1, output: 1, cacheRead: 0, costUsd: costs[i] } })).reverse();

test("групування: три запуски одного ланцюга стають однією позицією з сумою витрат і заголовком", () => {
  const entries = groupRuns(chain3("c1", 1000), nameOf);
  assert.equal(entries.length, 1);
  const g = entries[0];
  assert.equal(g.kind, "chain");
  if (g.kind !== "chain") return;
  assert.deepEqual(g.runs.map((r) => r.agentId), ["search", "posts", "review"], "кроки у порядку виконання");
  assert.ok(Math.abs(g.costUsd - 0.21) < 1e-9);
  assert.equal(g.title, "Пост з дослідженням · x: тема");
  assert.equal(g.at, 1000, "час початку ланцюга, а не останнього кроку");
  assert.equal(g.total, 3);
});

test("групування: позиція ланцюга там, де його найновіший запуск; запуски поза ланцюгами лишаються окремими", () => {
  const solo1 = run("docs", 9000);
  const solo2 = run("docs", 100);
  const entries = groupRuns([solo1, ...chain3("c1", 5000), solo2], nameOf);
  assert.deepEqual(entries.map((e) => e.kind), ["run", "chain", "run"]);
  assert.equal(entries[0].kind === "run" && entries[0].run.id, solo1.id);
});

test("групування: два ланцюга не змішуються", () => {
  const entries = groupRuns([...chain3("b", 9000), ...chain3("a", 1000)], nameOf);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => (e.kind === "chain" ? e.id : "")), ["b", "a"]);
  assert.ok(entries.every((e) => e.kind === "chain" && e.runs.length === 3));
});

test("порядок кроків береться з номера кроку, а не лише з часу (однаковий час не плутає)", () => {
  const same = ["search", "posts", "review"].map((a, i) => run(a, 5000, { chainId: "c", chain: info(i) })).reverse();
  const g = groupRuns(same, nameOf)[0];
  assert.deepEqual(g.kind === "chain" && g.runs.map((r) => r.agentId), ["search", "posts", "review"]);
});

test("зупинений ланцюг: відомо, що виконано менше кроків, ніж заплановано", () => {
  const entries = groupRuns(chain3("c1", 1000).slice(1), nameOf);
  const g = entries[0];
  assert.ok(g.kind === "chain" && g.runs.length === 2 && g.total === 3);
});

test("старі записи без підпису: заголовок зі списку агентів, номер кроку за позицією", () => {
  const old = ["search", "posts", "review"].map((a, i) => run(a, 1000 + i * 1000, { chainId: "old" })).reverse();
  const g = groupRuns(old, nameOf)[0];
  assert.ok(g.kind === "chain");
  if (g.kind !== "chain") return;
  assert.equal(g.title, "Ланцюг · Пошук → Пости → Перевірка");
  assert.equal(g.total, undefined);
  assert.deepEqual(g.runs.map((r, k) => stepLabel(r, k, nameOf)), ["Крок 1 · Пошук", "Крок 2 · Пости", "Крок 3 · Перевірка"]);
  assert.equal(chainTitle(g.runs, nameOf), g.title);
});

test("підпис кроку з номером і загальною кількістю", () => {
  const r = run("posts", 1, { chainId: "c", chain: info(1) });
  assert.equal(stepLabel(r, 0, nameOf), "Крок 2 з 3 · Пости", "береться індекс із запису, а не позиція");
});

test("порожній журнал дає порожній список", () => {
  assert.deepEqual(groupRuns([], nameOf), []);
});
