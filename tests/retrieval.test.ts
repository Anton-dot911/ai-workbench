import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, addMemory } from "../src/db/db.js";
import { normalizeTerm, retrieve } from "../src/core/retrieval.js";
import type { Artifact } from "../src/core/types.js";

const art = (title: string, content: string, type: Artifact["type"] = "document"): Artifact => ({
  id: crypto.randomUUID(),
  type,
  title,
  content,
  summary: content.slice(0, 100),
  versions: [],
  updatedAt: Date.now(),
});

beforeEach(async () => {
  await Promise.all([db.memory.clear(), db.artifacts.clear()]);
});

test("нормалізація: обрізання до 6 літер, апострофи, стоп-слова", () => {
  assert.equal(normalizeTerm("документами"), "докуме");
  assert.equal(normalizeTerm("п'ять"), "пять");
  assert.equal(normalizeTerm("та"), null);
  assert.equal(normalizeTerm("A"), null);
});

test("знаходить факт за іншою формою слова", async () => {
  await addMemory({ text: "Веду Telegram-канал про DevOps", tags: ["канал"], pinned: false, source: "user" });
  await addMemory({ text: "Пишу українською, на «ви»", tags: [], pinned: false, source: "user" });
  const hits = await retrieve("канали про девопс", { kind: "memory", topK: 3 });
  assert.equal(hits.length > 0, true);
  const first = await db.memory.get(hits[0].id);
  assert.match(first!.text, /Telegram/);
});

test("українські відмінки: документи → документів", async () => {
  await db.artifacts.add(art("Опис документів проєкту", "Тут описано всі документи й договори"));
  const hits = await retrieve("потрібні документами", { kind: "artifact", topK: 3 });
  assert.equal(hits.length, 1);
});

test("фільтр за типом артефакту і за видом запису", async () => {
  await db.artifacts.add(art("Пост про PWA", "офлайн режим у PWA", "post"));
  await db.artifacts.add(art("Стаття про PWA", "офлайн режим у PWA", "document"));
  await addMemory({ text: "PWA працює офлайн", tags: [], pinned: false, source: "user" });
  const docs = await retrieve("PWA офлайн", { kind: "artifact", types: ["document"], topK: 5 });
  assert.equal(docs.length, 1);
  const mem = await retrieve("PWA офлайн", { kind: "memory", topK: 5 });
  assert.equal(mem.every((h) => h.kind === "memory"), true);
});

test("порожній запит і відсутність збігів дають порожній результат", async () => {
  await addMemory({ text: "Щось зовсім інше", tags: [], pinned: false, source: "user" });
  assert.deepEqual(await retrieve("   ", { topK: 3 }), []);
  assert.deepEqual(await retrieve("квантова хромодинаміка", { topK: 3 }), []);
});

test("індекс оновлюється після змін у базі", async () => {
  assert.deepEqual(await retrieve("маршрутизатор", { kind: "memory", topK: 3 }), []);
  await addMemory({ text: "Мій маршрутизатор у коридорі", tags: [], pinned: false, source: "user" });
  assert.equal((await retrieve("маршрутизатор", { kind: "memory", topK: 3 })).length, 1);
});

test("exclude виключає записи, topK обмежує кількість", async () => {
  const a = await addMemory({ text: "кава вранці", tags: [], pinned: false, source: "user" });
  await addMemory({ text: "кава вдень", tags: [], pinned: false, source: "user" });
  await addMemory({ text: "кава ввечері", tags: [], pinned: false, source: "user" });
  const hits = await retrieve("кава", { kind: "memory", topK: 2, exclude: new Set([a.id]) });
  assert.equal(hits.length, 2);
  assert.equal(hits.some((h) => h.id === a.id), false);
});
