import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };

process.env.APP_TOKEN = "tok";
process.env.BUDGET_STORE = "memory";

const api = await import("../api/backup.js");
const { resetMemoryKv } = await import("../api/_lib/kv.js");
const { addMemory, db, emptyProfile, saveProfile } = await import("../src/db/db.js");
const { backupMeta, buildBackup, pushBackup, restoreBackup, isAutoBackup, setAutoBackup } = await import("../src/db/backup.js");

const req = (method: string, body?: unknown, token = "tok", qs = "") =>
  new Request("http://x/api/backup" + qs, { method, headers: { "x-app-token": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// «Мережа» для клієнтського коду: /api/backup іде в обробник.
const realFetch = globalThis.fetch;
function wire() {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (!u.startsWith("/api/backup")) throw new Error("несподіваний запит " + u);
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    const r = new Request("http://x" + u, { method, headers, body: init.body });
    return method === "POST" ? api.POST(r) : api.GET(r);
  }) as typeof fetch;
}

beforeEach(async () => {
  resetMemoryKv();
  store.clear();
  await Promise.all([db.memory.clear(), db.artifacts.clear(), db.profile.clear()]);
  wire();
});

test("API: без токена 401; копії немає → 404", async () => {
  assert.equal((await api.GET(req("GET", undefined, "bad"))).status, 401);
  assert.equal((await api.POST(req("POST", { memory: [{ text: "x" }] }, "bad"))).status, 401);
  assert.equal((await api.GET(req("GET"))).status, 404);
});

test("API: збереження, мета й дані, попередня копія лишається", async () => {
  const a = await api.POST(req("POST", { profile: [{ tone: "діловий" }], memory: [{ text: "один" }], artifacts: [] }));
  assert.equal(a.status, 200);
  assert.deepEqual((await a.json()).counts, { profile: true, memory: 1, artifacts: 0 });
  await api.POST(req("POST", { memory: [{ text: "один" }, { text: "два" }] }));
  const meta = await (await api.GET(req("GET", undefined, "tok", "?meta=1"))).json();
  assert.equal(meta.counts.memory, 2);
  assert.equal("data" in meta, false);
  const full = await (await api.GET(req("GET"))).json();
  assert.equal(full.data.memory.length, 2);
  const { createKv } = await import("../api/_lib/kv.js");
  const prev: any = await createKv(process.env as any).getJson("backup:prev");
  assert.equal(prev.counts.memory, 1, "попередня копія збережена");
});

test("API: порожня й завелика копії відхиляються, мова за замовчуванням не рахується", async () => {
  assert.equal((await api.POST(req("POST", { profile: [{ language: "uk" }], memory: [], artifacts: [] }))).status, 400);
  assert.equal((await api.POST(req("POST", { foo: 1 }))).status, 400);
  assert.equal((await api.POST(req("POST", [1]))).status, 400);
  const big = await api.POST(req("POST", { memory: [{ text: "x".repeat(900_000) }] }));
  assert.equal(big.status, 413);
  assert.equal((await api.GET(req("GET"))).status, 404, "нічого не збережено");
});

test("клієнт: порожній локальний стан не відправляється і не затирає копію", async () => {
  await addMemory({ text: "Важливий факт", tags: [], pinned: true, source: "user" });
  const first = await pushBackup("tok");
  assert.ok(first.meta);
  await db.memory.clear();
  assert.deepEqual(await pushBackup("tok", { force: true }), { skipped: "empty" });
  const meta = await backupMeta("tok");
  assert.equal(meta!.counts.memory, 1, "хмарна копія вціліла");
});

test("клієнт: незмінений вміст пропускається, зміна відправляється", async () => {
  await addMemory({ text: "Факт", tags: [], pinned: false, source: "user" });
  assert.ok((await pushBackup("tok")).meta);
  assert.equal((await pushBackup("tok")).skipped, "same");
  await addMemory({ text: "Ще факт", tags: [], pinned: false, source: "user" });
  assert.equal((await pushBackup("tok")).meta!.counts.memory, 2);
});

test("відновлення після втрати даних: профіль і факти повертаються, дублів немає", async () => {
  await saveProfile({ ...emptyProfile(), tone: "прямий, без води" });
  await addMemory({ text: "Закріплений факт", tags: ["а"], pinned: true, source: "user" });
  await pushBackup("tok");
  await Promise.all([db.memory.clear(), db.profile.clear()]);
  const s = await restoreBackup("tok");
  assert.deepEqual({ p: s.profile, m: s.memory }, { p: true, m: 1 });
  assert.equal((await db.memory.where("pinned").equals(1).toArray()).length, 1);
  assert.equal((await db.profile.get("me"))!.tone, "прямий, без води");
  const again = await restoreBackup("tok");
  assert.equal(again.memory, 0, "повторне відновлення нічого не дублює");
  assert.equal(await db.memory.count(), 1);
});

test("відновлення без копії → зрозуміла помилка; помилка авторизації розпізнається", async () => {
  await assert.rejects(() => restoreBackup("tok"), /копії ще немає/);
  assert.deepEqual(await pushBackup("bad"), { skipped: "empty" }, "порожній локальний стан навіть не йде в мережу");
  await addMemory({ text: "Факт", tags: [], pinned: false, source: "user" });
  await assert.rejects(() => pushBackup("bad"), (e: any) => e.kind === "auth");
});

test("автокопія: перемикач зберігається в localStorage; backup не містить журналу запусків", async () => {
  assert.equal(isAutoBackup(), false);
  setAutoBackup(true);
  assert.equal(isAutoBackup(), true);
  setAutoBackup(false);
  assert.equal(isAutoBackup(), false);
  const b = await buildBackup();
  assert.equal("runs" in b, false);
  globalThis.fetch = realFetch;
});
