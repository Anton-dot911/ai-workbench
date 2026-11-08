import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { addMemory, db, exportAll, getProfile, saveProfile, emptyProfile } from "../src/db/db.js";
import { describeBundle, importBundle, parseBundle } from "../src/db/importexport.js";

const SEED = readFileSync(new URL("../seed/workbench-seed.json", import.meta.url), "utf8");

beforeEach(async () => {
  await Promise.all([db.memory.clear(), db.artifacts.clear(), db.runs.clear(), db.profile.clear()]);
});

const parse = (t: string) => {
  const r = parseBundle(t);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return (r as Extract<typeof r, { ok: true }>).bundle;
};

test("готовий пакет: профіль заповнюється, факти додаються, закріплені мають pinned=1", async () => {
  const b = parse(SEED);
  assert.match(describeBundle(b), /профіль, фактів: 5/);
  const s = await importBundle(b);
  assert.deepEqual({ p: s.profile, m: s.memory, sk: s.skipped }, { p: true, m: 5, sk: 0 });
  const p = await getProfile();
  assert.match(p.tone, /без води/);
  assert.equal(p.codingPrefs!.stack.includes("Vercel"), true);
  const pinned = await db.memory.where("pinned").equals(1).toArray();
  assert.equal(pinned.length, 4);
  assert.equal((await db.memory.count()), 5);
});

test("повторний імпорт нічого не дублює", async () => {
  await importBundle(parse(SEED));
  const again = await importBundle(parse(SEED));
  assert.equal(again.memory, 0);
  assert.equal(again.skipped, 5);
  assert.equal(await db.memory.count(), 5);
});

test("профіль: заповнені поля імпорту перезаписують, порожні не стирають наявні", async () => {
  await saveProfile({ ...emptyProfile(), tone: "старий тон", audience: "моя аудиторія" });
  await importBundle(parse(JSON.stringify({ profile: { tone: "новий тон", audience: "" } })));
  const p = await getProfile();
  assert.equal(p.tone, "новий тон");
  assert.equal(p.audience, "моя аудиторія");
});

test("круговий шлях: експорт → очищення → імпорт відновлює все", async () => {
  await saveProfile({ ...emptyProfile(), tone: "діловий" });
  await addMemory({ text: "Факт один", tags: ["а"], pinned: true, source: "agent" });
  const now = Date.now();
  await db.artifacts.add({ id: "art-1", type: "document", title: "Док", content: "Текст", summary: "Текст", versions: [{ at: now, content: "Текст" }], updatedAt: now });
  await db.runs.add({
    id: "run-1", agentId: "docs", input: "x", output: "y", createdAt: now,
    contextSnapshot: { stable: "", relevant: "", operative: "", tokenEstimate: 0, sources: [] },
    usage: { input: 1, output: 2, cacheRead: 0, costUsd: 0.01 },
  });
  const dump = JSON.stringify(await exportAll());
  await Promise.all([db.memory.clear(), db.artifacts.clear(), db.runs.clear(), db.profile.clear()]);
  const s = await importBundle(parse(dump));
  assert.deepEqual({ p: s.profile, m: s.memory, a: s.artifacts, r: s.runs }, { p: true, m: 1, a: 1, r: 1 });
  assert.equal((await db.memory.toArray())[0].pinned, 1);
  assert.equal((await db.memory.toArray())[0].source, "agent");
  assert.equal((await getProfile()).tone, "діловий");
});

test("помилки формату: не JSON, не пакет, порожній пакет", () => {
  const a = parseBundle("це не json");
  assert.equal(a.ok, false);
  assert.match((a as any).error, /Це не JSON/);
  assert.equal(parseBundle("[1,2]").ok, false);
  assert.equal(parseBundle('{"foo":1}').ok, false);
  assert.equal(parseBundle('{"memory":[]}').ok, false);
});

test("некоректні записи пропускаються, коректні імпортуються", async () => {
  const b = parse(JSON.stringify({ memory: [{ text: "Добрий факт" }, { text: "" }, { foo: 1 }], artifacts: [{ id: "x" }] }));
  assert.equal(b.invalid, 3);
  const s = await importBundle(b);
  assert.equal(s.memory, 1);
  assert.equal(s.skipped, 3);
});

test("pinned: true/1 → 1, відсутнє → 0", async () => {
  await importBundle(parse(JSON.stringify({ memory: [{ text: "а", pinned: true }, { text: "б", pinned: 1 }, { text: "в" }] })));
  const rows = await db.memory.toArray();
  assert.deepEqual(rows.map((r) => r.pinned).sort(), [0, 1, 1]);
});
