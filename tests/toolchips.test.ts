import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolEvent } from "../src/core/runner.js";
import { applyToolEvent, settleTools, type ToolChip } from "../src/ui/toolChips.js";

const play = (events: ToolEvent[], from: ToolChip[] = []): ToolChip[] => events.reduce((tools, e) => applyToolEvent(tools, e), from);
const statuses = (t: ToolChip[]) => t.map((c) => `${c.name}:${c.status}`);

/** Старий алгоритм: оновлювалась лише остання мітка з тією ж назвою (для порівняння з відтвореним баґом). */
function legacyApply(tools: ToolChip[], e: ToolEvent): ToolChip[] {
  if (e.status === "start") return [...tools, { name: e.name, status: "start", detail: e.detail }];
  return tools.map((t, k) => (k === tools.length - 1 && t.name === e.name ? { ...t, status: e.status, ...(e.detail ? { detail: e.detail } : {}) } : t));
}

// Послідовність зі скриншота «Пошуку» (15.11): пошук, пошук у пам'яті між початком і кінцем, паралельні пошуки.
const SCREENSHOT: ToolEvent[] = [
  { name: "web_search", status: "start", detail: "AI agent memory trends 2026" },
  { name: "search_context", status: "start" },
  { name: "search_context", status: "ok" },
  { name: "web_search", status: "ok" },
  { name: "web_search", status: "start", detail: "Anthropic Dreaming agent memory Claude" },
  { name: "web_search", status: "start", detail: "Google Memory Bank I/O 2026" },
  { name: "web_search", status: "ok" },
  { name: "web_search", status: "ok" },
];

test("відтворення баґу: старий алгоритм лишає частину веб-пошуків у стані «…»", () => {
  const old = SCREENSHOT.reduce(legacyApply, [] as ToolChip[]);
  assert.ok(old.some((c) => c.status === "start"), "у старому алгоритмі лишаються мітки «…»");
  assert.equal(old.filter((c) => c.status === "start").length, 2, "саме два пошуки, як на скриншоті");
});

test("мітки: усі веб-пошуки завершуються, навіть коли між початком і кінцем були інші інструменти й паралельні пошуки", () => {
  const tools = play(SCREENSHOT);
  assert.deepEqual(statuses(tools), ["web_search:ok", "search_context:ok", "web_search:ok", "web_search:ok"]);
  assert.equal(tools[0].detail, "AI agent memory trends 2026", "запит зберігається");
  assert.equal(tools[3].detail, "Google Memory Bank I/O 2026");
});

test("мітки: завершення пов'язується з найстарішим очікуваним пошуком (порядок запуску), а не з останнім", () => {
  const tools = play([
    { name: "web_search", status: "start", detail: "перший" },
    { name: "web_search", status: "start", detail: "другий" },
    { name: "web_search", status: "ok" },
  ]);
  assert.deepEqual(tools.map((c) => `${c.detail}:${c.status}`), ["перший:ok", "другий:start"]);
});

test("мітки: помилка інструмента позначається, а не губиться; детальна інформація з події оновлюється", () => {
  const tools = play([
    { name: "web_search", status: "start", detail: "запит" },
    { name: "web_search", status: "error", detail: "max_uses_exceeded" },
  ]);
  assert.deepEqual(tools, [{ name: "web_search", status: "error", detail: "max_uses_exceeded" }]);
});

test("мітки: завершення без відповідного початку ігнорується (нових міток не з'являється)", () => {
  const before: ToolChip[] = [{ name: "apply_edits", status: "ok" }];
  assert.deepEqual(applyToolEvent(before, { name: "apply_edits", status: "ok" }), before, "вже завершена мітка не змінюється");
  assert.deepEqual(applyToolEvent([], { name: "web_search", status: "ok" }), []);
});

test("мітки: стан не мутується (React бачить нові масиви й об'єкти)", () => {
  const before: ToolChip[] = [{ name: "web_search", status: "start" }];
  const after = applyToolEvent(before, { name: "web_search", status: "ok" });
  assert.equal(before[0].status, "start");
  assert.notEqual(after, before);
  assert.notEqual(after[0], before[0]);
});

test("завершений запуск не лишає «…»: очікувані мітки позначаються виконаними, решта без змін", () => {
  const tools = settleTools([
    { name: "web_search", status: "start", detail: "x" },
    { name: "search_context", status: "ok" },
    { name: "apply_edits", status: "error" },
  ]);
  assert.deepEqual(statuses(tools), ["web_search:ok", "search_context:ok", "apply_edits:error"]);
  assert.equal(tools[0].detail, "x");
});
