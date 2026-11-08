import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setSession, getSession } from "../src/core/session.js";
import { addMemory, db } from "../src/db/db.js";
import { applyEdits, countOccurrences } from "../src/tools/edits.js";
import { TOOL_HANDLERS, toolDefs } from "../src/tools/handlers.js";
import type { Artifact } from "../src/core/types.js";

const ctx = { ui: {} };
const art = (content: string, title = "Документ"): Artifact => ({
  id: crypto.randomUUID(), type: "document", title, content, summary: content.slice(0, 50), versions: [{ at: 1, content }], updatedAt: 1,
});

beforeEach(async () => {
  await Promise.all([db.artifacts.clear(), db.memory.clear()]);
  setSession({ frag: "" });
});

test("applyEdits: унікальна заміна, вставка після, послідовність", () => {
  const r = applyEdits("у рамках проєкту. Даний документ описує", [
    { find: "у рамках", replace: "у межах" },
    { find: "Даний документ", replace: "Документ" },
    { insertAfter: "описує", text: " план" },
  ]);
  assert.equal(r.result, "у межах проєкту. Документ описує план");
  assert.deepEqual(r.applied, [0, 1, 2]);
  assert.equal(r.failed.length, 0);
});

test("applyEdits: не знайдено, неоднозначно, порожній find; решта застосовується", () => {
  const r = applyEdits("кіт і кіт і пес", [
    { find: "кіт", replace: "кіт1" },
    { find: "миша", replace: "x" },
    { find: "пес", replace: "собака" },
  ]);
  assert.equal(r.result, "кіт і кіт і собака");
  assert.deepEqual(r.failed.map((f) => f.index), [0, 1]);
  assert.match(r.failed[0].error, /неоднозначно: 2/);
  assert.match(r.failed[1].error, /не знайдено/);
  assert.equal(countOccurrences("aaa", "aa"), 1);
});

test("applyEdits: only обмежує набір правок", () => {
  const r = applyEdits("a b c", [{ find: "a", replace: "1" }, { find: "c", replace: "3" }], new Set([1]));
  assert.equal(r.result, "a b 3");
});

test("apply_edits: артефакт за префіксом id, diff-превʼю, нова версія", async () => {
  const a = art("У рамках проєкту ми працюємо.");
  await db.artifacts.add(a);
  const h = TOOL_HANDLERS.apply_edits;
  const input = { target: `#${a.id.slice(0, 8)}`, edits: [{ find: "У рамках", replace: "У межах", reason: "калька" }, { find: "немає такого", replace: "x" }] };
  const plan = await h.plan!(input, ctx);
  assert.equal(plan.error, undefined);
  assert.equal(plan.confirm!.edits.length, 2);
  assert.equal(plan.confirm!.edits[0].ok, true);
  assert.equal(plan.confirm!.edits[1].ok, false);
  const out = await h.run(input, ctx, { approve: true, accepted: [0] });
  assert.match(out.content, /Застосовано правок: 1 з 2/);
  const after = (await db.artifacts.get(a.id))!;
  assert.equal(after.content, "У межах проєкту ми працюємо.");
  assert.equal(after.versions.length, 2, "стара версія збережена, нова додана");
  assert.equal(after.versions[0].content, "У рамках проєкту ми працюємо.");
});

test("apply_edits: цілі «selection» змінюють фрагмент у сесії", async () => {
  setSession({ frag: "Даний текст" });
  const out = await TOOL_HANDLERS.apply_edits.run({ target: "selection", edits: [{ find: "Даний", replace: "Цей" }] }, ctx, { approve: true });
  assert.equal(getSession().frag, "Цей текст");
  assert.equal(out.isError, undefined);
});

test("apply_edits: усі правки хибні → помилка без підтвердження; порожній фрагмент", async () => {
  setSession({ frag: "текст" });
  const plan = await TOOL_HANDLERS.apply_edits.plan!({ target: "selection", edits: [{ find: "немає", replace: "x" }] }, ctx);
  assert.match(plan.error!, /Жодну правку не застосовано/);
  assert.equal(plan.confirm, undefined);
  setSession({ frag: "  " });
  await assert.rejects(() => TOOL_HANDLERS.apply_edits.plan!({ target: "selection", edits: [{ find: "a", replace: "b" }] }, ctx), /порожній/);
});

test("apply_edits: некоректний вхід відхиляється валідацією", async () => {
  await assert.rejects(() => TOOL_HANDLERS.apply_edits.plan!({ target: "selection", edits: [] }, ctx));
  await assert.rejects(() => TOOL_HANDLERS.apply_edits.plan!({ target: "selection", edits: [{ foo: 1 }] }, ctx));
});

test("read_artifact читає частинами через offset/limit", async () => {
  const a = art("0123456789");
  await db.artifacts.add(a);
  const first = JSON.parse((await TOOL_HANDLERS.read_artifact.run({ id: a.id, offset: 0, limit: 4 }, ctx)).content);
  assert.equal(first.content, "0123");
  assert.equal(first.nextOffset, 4);
  const last = JSON.parse((await TOOL_HANDLERS.read_artifact.run({ id: a.id, offset: 8, limit: 10 }, ctx)).content);
  assert.equal(last.content, "89");
  assert.equal(last.nextOffset, null);
  await assert.rejects(() => TOOL_HANDLERS.read_artifact.run({ id: "nonexistent-id" }, ctx), /не знайдено/);
});

test("search_context шукає в пам'яті й артефактах", async () => {
  await addMemory({ text: "Веду канал про DevOps", tags: [], pinned: false, source: "user" });
  await db.artifacts.add(art("Нотатки про Service Worker і кеш", "Service Worker"));
  const mem = JSON.parse((await TOOL_HANDLERS.search_context.run({ query: "DevOps канал", kind: "memory" }, ctx)).content);
  assert.equal(mem[0].kind, "memory");
  const all = JSON.parse((await TOOL_HANDLERS.search_context.run({ query: "Service Worker" }, ctx)).content);
  assert.equal(all[0].kind, "artifact");
  assert.ok(all[0].id);
});

test("save_artifact створює новий артефакт", async () => {
  const out = JSON.parse((await TOOL_HANDLERS.save_artifact.run({ title: "Нотатка", content: "Текст нотатки", type: "note" }, ctx)).content);
  const saved = (await db.artifacts.get(out.id))!;
  assert.equal(saved.type, "note");
  assert.equal(saved.versions.length, 1);
});

test("ask_user передає питання в UI і повертає відповідь", async () => {
  let asked = "";
  const out = await TOOL_HANDLERS.ask_user.run({ question: "Для кого?", options: ["клієнти", "техліди"] }, { ui: { ask: async (r) => ((asked = r.question), "техліди") } });
  assert.equal(asked, "Для кого?");
  assert.equal(out.content, "техліди");
  assert.equal((await TOOL_HANDLERS.ask_user.run({ question: "?" }, ctx)).isError, true);
});

test("toolDefs: невідомий інструмент → помилка, відомі мають схему", () => {
  assert.throws(() => toolDefs("nope"), /Невідомий/);
  for (const d of toolDefs("search_context", "read_artifact", "apply_edits", "save_artifact", "ask_user")) {
    assert.equal(d.input_schema.type, "object");
    assert.ok(d.description.length > 20);
  }
});
