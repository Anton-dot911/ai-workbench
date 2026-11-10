import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };

const { db, addMemory, saveProfile, emptyProfile } = await import("../src/db/db.js");
const { checkHealth, selfTest, dataCounts, isLocalEmpty, profileFilled } = await import("../src/db/health.js");

beforeEach(async () => {
  store.clear();
  await Promise.all([db.meta.clear(), db.memory.clear(), db.artifacts.clear(), db.profile.clear(), db.runs.clear()]);
});

test("перший запуск: fresh, маркер записується в обидва сховища", async () => {
  const h = await checkHealth(1000);
  assert.deepEqual({ fresh: h.fresh, idbWiped: h.idbWiped, lsCleared: h.lsCleared, first: h.firstSeen }, { fresh: true, idbWiped: false, lsCleared: false, first: 1000 });
  assert.equal(store.get("wb.firstSeen"), "1000");
  assert.equal((await db.meta.get("firstSeen"))!.value, 1000);
});

test("повторний запуск: нічого не змінюється, firstSeen зберігається", async () => {
  await checkHealth(1000);
  const h = await checkHealth(5000);
  assert.deepEqual({ fresh: h.fresh, idbWiped: h.idbWiped, lsCleared: h.lsCleared, first: h.firstSeen }, { fresh: false, idbWiped: false, lsCleared: false, first: 1000 });
});

test("IndexedDB очищено, а localStorage лишився → idbWiped", async () => {
  await checkHealth(1000);
  await db.meta.clear();
  const h = await checkHealth(9000);
  assert.equal(h.idbWiped, true);
  assert.equal(h.firstSeen, 1000, "дата першого запуску береться з localStorage");
  assert.equal((await db.meta.get("firstSeen"))!.value, 1000, "маркер відновлено");
});

test("localStorage очищено, а IndexedDB лишилась → lsCleared", async () => {
  await checkHealth(1000);
  store.clear();
  const h = await checkHealth(9000);
  assert.deepEqual({ ls: h.lsCleared, wiped: h.idbWiped, first: h.firstSeen }, { ls: true, wiped: false, first: 1000 });
});

test("самоперевірка запису проходить і не залишає службових записів", async () => {
  const r = await selfTest();
  assert.equal(r.ok, true);
  assert.equal(await db.meta.get("selftest"), undefined);
});

test("лічильники й порожнеча: мова за замовчуванням не робить профіль заповненим", async () => {
  assert.equal(isLocalEmpty(await dataCounts()), true);
  await saveProfile({ ...emptyProfile(), language: "uk" });
  assert.equal(isLocalEmpty(await dataCounts()), true);
  await saveProfile({ ...emptyProfile(), tone: "діловий" });
  const c = await dataCounts();
  assert.equal(c.profile, true);
  assert.equal(isLocalEmpty(c), false);
  await db.profile.clear();
  await addMemory({ text: "Факт", tags: [], pinned: false, source: "user" });
  assert.deepEqual({ m: (await dataCounts()).memory, empty: isLocalEmpty(await dataCounts()) }, { m: 1, empty: false });
  assert.equal(profileFilled({ codingPrefs: { stack: ["TS"], style: "" } }), true);
  assert.equal(profileFilled(undefined), false);
});

test("нові версії схеми зберегли дані v1: старі таблиці читаються після оновлення", async () => {
  await addMemory({ text: "Старий факт", tags: [], pinned: true, source: "user" });
  await db.close();
  await db.open();
  assert.equal(await db.memory.count(), 1);
  assert.ok(db.verno >= 3, `версія схеми ${db.verno}`);
});
