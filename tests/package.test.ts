import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { db } from "../src/db/db.js";
import { exportAll } from "../src/db/db.js";
import { importBundle, parseBundle } from "../src/db/importexport.js";
import {
  canTransition,
  findCycle,
  hasErrors,
  isEditable,
  newPackage,
  PackageError,
  parsePackage,
  readyTasks,
  renderDocuments,
  revise,
  taskOrder,
  traceability,
  transition,
  updateDraft,
  validatePackage,
  type EngineeringPackage,
} from "../src/engineering/package.js";
import { listPackages, loadPackage, packageArtifactId, savePackage } from "../src/engineering/store.js";

// T5.1: модель пакета інженерних специфікацій. Приклад: модуль «імпорт бази» (перший тестовий модуль).

const NOW = 1_700_000_000_000;

/** Повний валідний пакет-приклад («імпорт бази»). */
function importPackage(): EngineeringPackage {
  const p = newPackage("workbench-import", { packageId: "pkg-import", now: NOW, summary: "Імпорт бази: лише додає записи, без дублів." });
  return {
    ...p,
    architecture: "Імпорт читає файл експорту або вставлений JSON, перевіряє схемою й додає лише відсутні записи в Dexie.",
    requirements: [
      { id: "REQ-001", title: "Імпорт лише додає", description: "Імпорт ніколи не видаляє й не перезаписує наявні записи.", priority: "must", kind: "confirmed", acceptance: [{ text: "Наявні факти після імпорту не змінились", verification: "test" }] },
      { id: "REQ-002", title: "Без дублів", description: "Однакові факти й записи з тим самим id пропускаються.", priority: "must", kind: "confirmed", acceptance: [{ text: "Повторний імпорт нічого не додає", verification: "test" }] },
      { id: "REQ-003", title: "Імпорт зі вставленого JSON", description: "Крім файлу, можна вставити JSON у поле.", priority: "should", kind: "preference", acceptance: [{ text: "Вставлений JSON імпортується так само, як файл", verification: "manual" }] },
    ],
    components: [
      { id: "COMP-001", name: "Схема імпорту", purpose: "Перевіряє форму файлу.", responsibilities: ["Відхиляти невалідні записи з поясненням"], inputs: ["JSON"], outputs: ["Перевірені записи"], dependsOn: [], errors: ["Невалідний JSON"] },
      { id: "COMP-002", name: "Імпортер", purpose: "Додає записи в базу.", responsibilities: ["Пропускати дублі", "Не перезаписувати наявне"], inputs: ["Перевірені записи"], outputs: ["Звіт імпорту"], dependsOn: ["COMP-001"], errors: ["Помилка запису"] },
    ],
    dataModel: [
      { id: "ENT-001", name: "MemoryItem", description: "Факт пам'яті", fields: [{ name: "id", type: "string", required: true }, { name: "text", type: "string", required: true }], relations: [] },
    ],
    tasks: [
      { id: "TASK-001", title: "Схема файлу імпорту", description: "zod-схема для профілю, пам'яті, артефактів і запусків.", requirements: ["REQ-001"], components: ["COMP-001"], dependsOn: [], files: ["src/db/importexport.ts"], acceptance: ["Невалідний запис відхиляється з поясненням"], verification: "npm run check" },
      { id: "TASK-002", title: "Додавання без дублів", description: "Додає відсутні записи, пропускає наявні.", requirements: ["REQ-001", "REQ-002"], components: ["COMP-002"], dependsOn: ["TASK-001"], files: ["src/db/importexport.ts"], acceptance: ["Повторний імпорт додає 0 записів"], verification: "tests/importexport.test.ts" },
      { id: "TASK-003", title: "Імпорт зі вставленого JSON", description: "Поле вставки в екрані імпорту.", requirements: ["REQ-003"], components: ["COMP-002"], dependsOn: ["TASK-002"], files: ["src/ui/ImportSheet.tsx"], acceptance: ["Вставлений JSON імпортується"], verification: "Димовий тест" },
    ],
    openQuestions: [{ id: "Q-001", text: "Чи імпортувати журнал запусків?", blocking: false }],
  };
}

const codes = (p: EngineeringPackage, opts?: { complete?: boolean }) => validatePackage(p, opts).map((i) => i.code);
const errorCodes = (p: EngineeringPackage, opts?: { complete?: boolean }) => validatePackage(p, opts).filter((i) => i.severity === "error").map((i) => i.code);
const clone = (p: EngineeringPackage): EngineeringPackage => JSON.parse(JSON.stringify(p));

beforeEach(async () => {
  await Promise.all([db.artifacts.clear(), db.memory.clear(), db.profile.clear(), db.runs.clear()]);
});

// ---------- форма ----------
test("форма: приклад і порожній пакет проходять розбір; невірні ідентифікатори й версія відхиляються", () => {
  assert.equal(parsePackage(JSON.stringify(importPackage())).ok, true);
  assert.equal(parsePackage(newPackage("demo")).ok, true);
  const bad = clone(importPackage());
  (bad.requirements[0] as any).id = "REQ-1";
  const r = parsePackage(bad);
  assert.ok(!r.ok && /REQ-001/.test(r.error));
  const v = clone(importPackage());
  v.version = "v1";
  assert.equal(parsePackage(v).ok, false);
  assert.equal(parsePackage("не json").ok, false);
  const s = clone(importPackage());
  (s.requirements[0] as any).priority = "critical";
  assert.equal(parsePackage(s).ok, false);
});

// ---------- перевірка кодом ----------
test("перевірка: повний приклад без помилок, лише допустимі попередження", () => {
  const issues = validatePackage(importPackage(), { complete: true });
  assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  assert.equal(hasErrors(issues), false);
});

test("перевірка: дублі ідентифікаторів і порожні критерії", () => {
  const p = clone(importPackage());
  p.requirements.push({ ...p.requirements[0] });
  p.requirements[1].acceptance = [];
  const c = errorCodes(p);
  assert.ok(c.includes("DUP_ID"));
  assert.ok(c.includes("REQ_NO_ACCEPTANCE"));
});

test("перевірка: задачі посилаються лише на існуючі вимоги, компоненти й задачі", () => {
  const p = clone(importPackage());
  p.tasks[0].requirements = ["REQ-099"];
  p.tasks[1].components = ["COMP-099"];
  p.tasks[2].dependsOn = ["TASK-099"];
  const c = errorCodes(p);
  assert.ok(c.includes("TASK_UNKNOWN_REQUIREMENT") && c.includes("TASK_UNKNOWN_COMPONENT") && c.includes("TASK_UNKNOWN_DEP"));
});

test("перевірка: задача без вимоги, без способу перевірки й без критеріїв", () => {
  const p = clone(importPackage());
  p.tasks[0].requirements = [];
  p.tasks[1].verification = "  ";
  p.tasks[2].acceptance = ["   "];
  const c = errorCodes(p);
  assert.ok(c.includes("TASK_NO_REQUIREMENT") && c.includes("TASK_NO_VERIFICATION") && c.includes("TASK_NO_ACCEPTANCE"));
});

test("перевірка: цикли залежностей задач і компонентів, самозалежність", () => {
  const p = clone(importPackage());
  p.tasks[0].dependsOn = ["TASK-003"];
  p.components[0].dependsOn = ["COMP-002"];
  const c = errorCodes(p);
  assert.ok(c.includes("TASK_CYCLE") && c.includes("COMP_CYCLE"));
  const msg = validatePackage(p).find((i) => i.code === "TASK_CYCLE")!.message;
  // Напрямок «залежить від»: 001 → 003 → 002 → 001.
  assert.equal(msg, "Цикл залежностей задач: TASK-001 → TASK-003 → TASK-002 → TASK-001.");
  const s = clone(importPackage());
  s.tasks[0].dependsOn = ["TASK-001"];
  s.components[1].dependsOn = ["COMP-002"];
  const sc = errorCodes(s);
  assert.ok(sc.includes("TASK_SELF_DEP") && sc.includes("COMP_SELF_DEP"));
  assert.equal(findCycle(new Map([["a", ["b"]], ["b", ["c"]], ["c", []]])), null);
  assert.deepEqual(findCycle(new Map([["a", ["b"]], ["b", ["a"]]])), ["a", "b", "a"]);
});

test("перевірка: обов'язкова вимога без задачі це помилка, необов'язкова це попередження", () => {
  const p = clone(importPackage());
  p.tasks = p.tasks.filter((t) => t.id !== "TASK-003");
  p.requirements.push({ id: "REQ-004", title: "Обов'язкове без задачі", description: "x", priority: "must", kind: "confirmed", acceptance: [{ text: "перевірити щось", verification: "test" }] });
  const issues = validatePackage(p);
  assert.ok(issues.some((i) => i.code === "REQ_UNCOVERED" && i.path === "REQ-004" && i.severity === "error"));
  assert.ok(issues.some((i) => i.code === "REQ_UNCOVERED" && i.path === "REQ-003" && i.severity === "warning"));
});

test("перевірка: припущення не видаються за вимоги (must на припущенні, задача лише на припущеннях)", () => {
  const p = clone(importPackage());
  p.requirements[0].kind = "assumption";
  p.tasks[0].requirements = ["REQ-001"];
  const c = codes(p);
  assert.ok(c.includes("REQ_ASSUMPTION_MUST"));
  assert.ok(c.includes("TASK_ONLY_ASSUMPTIONS"));
  assert.equal(validatePackage(p).find((i) => i.code === "TASK_ONLY_ASSUMPTIONS")!.severity, "warning");
});

test("перевірка: модель даних (порожні сутності, дубль поля, невідомий зв'язок) і невикористаний компонент", () => {
  const p = clone(importPackage());
  p.dataModel[0].fields = [{ name: "id", type: "string", required: true }, { name: "id", type: "number", required: false }];
  p.dataModel.push({ id: "ENT-002", name: "Порожня", description: "x", fields: [], relations: [{ to: "ENT-009", cardinality: "1:N" }] });
  p.components.push({ id: "COMP-003", name: "Зайвий", purpose: "x", responsibilities: ["щось"], inputs: [], outputs: [], dependsOn: [], errors: [] });
  const issues = validatePackage(p);
  const c = issues.map((i) => i.code);
  assert.ok(c.includes("ENT_DUP_FIELD") && c.includes("ENT_NO_FIELDS") && c.includes("ENT_UNKNOWN_RELATION"));
  assert.equal(issues.find((i) => i.code === "COMP_UNUSED")!.severity, "warning");
});

test("повнота: порожній пакет має помилки лише з complete, блокувальне питання не дає пройти", () => {
  const empty = newPackage("demo");
  assert.deepEqual(errorCodes(empty), [], "чернетка в процесі наповнення не вважається помилковою");
  const full = errorCodes(empty, { complete: true });
  assert.ok(["EMPTY_REQUIREMENTS", "EMPTY_COMPONENTS", "EMPTY_TASKS", "EMPTY_ARCHITECTURE"].every((c) => full.includes(c)));
  const p = clone(importPackage());
  p.openQuestions = [{ id: "Q-001", text: "Чи імпортувати журнал?", blocking: true }];
  assert.ok(errorCodes(p, { complete: true }).includes("BLOCKING_QUESTION"));
  p.openQuestions[0].resolution = "Ні, журнал не імпортується.";
  assert.ok(!errorCodes(p, { complete: true }).includes("BLOCKING_QUESTION"), "вирішене питання не блокує");
});

// ---------- життєвий цикл ----------
test("статуси: дозволені й заборонені переходи", () => {
  assert.ok(canTransition("DRAFT", "REVIEW") && canTransition("REVIEW", "DRAFT") && canTransition("REVIEW", "APPROVED"));
  assert.ok(canTransition("APPROVED", "IN_IMPLEMENTATION") && canTransition("IN_IMPLEMENTATION", "COMPLETED") && canTransition("IN_IMPLEMENTATION", "CHANGE_REQUESTED"));
  assert.ok(!canTransition("DRAFT", "APPROVED"), "затвердження лише після перегляду");
  assert.ok(!canTransition("APPROVED", "DRAFT"), "затверджену версію не повертають у чернетку");
  assert.ok(!canTransition("ARCHIVED", "DRAFT") && !canTransition("COMPLETED", "IN_IMPLEMENTATION"));
  assert.ok(isEditable("DRAFT") && !isEditable("REVIEW") && !isEditable("APPROVED"));
});

test("перехід у REVIEW: лише повний пакет без помилок, історія записується", () => {
  assert.throws(() => transition(newPackage("demo", { now: NOW }), "REVIEW", { by: "agent" }), (e: unknown) => e instanceof PackageError && /не готовий/.test((e as Error).message));
  const r = transition(importPackage(), "REVIEW", { by: "agent", now: NOW + 1, note: "Готово до перегляду" });
  assert.equal(r.status, "REVIEW");
  assert.equal(r.updatedAt, NOW + 1);
  assert.deepEqual(r.history.at(-1), { at: NOW + 1, version: "1.0", status: "REVIEW", note: "Готово до перегляду" });
  assert.equal(r.history.length, 2, "початковий запис «Створено» лишився");
});

test("затвердження: лише користувач, після REVIEW; записується approval", () => {
  const review = transition(importPackage(), "REVIEW", { by: "agent" });
  assert.throws(() => transition(review, "APPROVED", { by: "agent" }), /лише користувач/);
  assert.throws(() => transition(importPackage(), "APPROVED", { by: "user" }), /неможливий/);
  const ok = transition(review, "APPROVED", { by: "user", now: NOW + 5, note: "Погоджено" });
  assert.equal(ok.status, "APPROVED");
  assert.deepEqual(ok.approval, { approvedAt: NOW + 5, note: "Погоджено" });
  // Блокувальне питання не дає затвердити.
  const blocked = clone(importPackage());
  blocked.openQuestions = [{ id: "Q-001", text: "Критичне питання", blocking: true }];
  assert.throws(() => transition(blocked, "REVIEW", { by: "agent" }), /блокувальне/);
});

test("незмінність: зафіксований пакет не редагується, лише ревізією з новим номером версії", () => {
  const approved = transition(transition(importPackage(), "REVIEW", { by: "agent" }), "APPROVED", { by: "user", now: NOW + 5 });
  assert.throws(() => updateDraft(approved, { summary: "інше" }), (e: unknown) => e instanceof PackageError && /revise/.test((e as Error).message));
  assert.equal(updateDraft(importPackage(), { summary: "нове" }, NOW + 9).summary, "нове");

  const v2 = revise(approved, { now: NOW + 10 });
  assert.equal(v2.version, "1.1");
  assert.equal(v2.status, "DRAFT");
  assert.equal(v2.supersedes, "1.0");
  assert.equal(v2.approval, undefined, "затвердження не переходить на нову версію");
  assert.equal(v2.packageId, approved.packageId);
  assert.deepEqual(v2.requirements, approved.requirements, "вміст скопійовано");
  assert.notEqual(v2.requirements, approved.requirements, "глибока копія, не посилання");
  assert.equal(approved.status, "APPROVED", "попередня версія не змінилась");
  assert.equal(approved.version, "1.0");
  assert.throws(() => revise(importPackage()), /Чернетку/);
});

// ---------- порядок, простежуваність, документи ----------
test("порядок задач за залежностями, стабільний; готові до старту", () => {
  const p = clone(importPackage());
  p.tasks.reverse();
  assert.deepEqual(taskOrder(p).map((t) => t.id), ["TASK-001", "TASK-002", "TASK-003"]);
  assert.deepEqual(readyTasks(p, []).map((t) => t.id), ["TASK-001"]);
  assert.deepEqual(readyTasks(p, ["TASK-001"]).map((t) => t.id), ["TASK-002"]);
  assert.deepEqual(readyTasks(p, ["TASK-001", "TASK-002", "TASK-003"]), []);
  const par = clone(importPackage());
  par.tasks[2].dependsOn = ["TASK-001"];
  assert.deepEqual(readyTasks(par, ["TASK-001"]).map((t) => t.id), ["TASK-002", "TASK-003"], "паралельні задачі");
  const cyc = clone(importPackage());
  cyc.tasks[0].dependsOn = ["TASK-003"];
  assert.throws(() => taskOrder(cyc), /Цикл/);
});

test("простежуваність: вимога → компоненти й задачі → способи перевірки", () => {
  const t = traceability(importPackage());
  assert.deepEqual(t.find((r) => r.requirement === "REQ-001"), { requirement: "REQ-001", title: "Імпорт лише додає", components: ["COMP-001", "COMP-002"], tasks: ["TASK-001", "TASK-002"], verification: ["test"] });
  assert.deepEqual(t.find((r) => r.requirement === "REQ-003")?.verification, ["manual"]);
  assert.equal(t.length, 3);
});

test("документи: чотири файли пакета відтворюються з даних, у ARCHITECTURE є діаграма залежностей", () => {
  const d = renderDocuments(importPackage());
  assert.deepEqual(Object.keys(d), ["REQUIREMENTS.md", "ARCHITECTURE.md", "DATA_MODEL.json", "TASKS.json"]);
  assert.match(d["REQUIREMENTS.md"], /## REQ-001 · Імпорт лише додає[\s\S]*\[test\] Наявні факти після імпорту не змінились/);
  assert.match(d["REQUIREMENTS.md"], /Q-001: Чи імпортувати журнал запусків\?/);
  assert.match(d["ARCHITECTURE.md"], /### COMP-002 · Імпортер[\s\S]*Залежить від: COMP-001/);
  assert.match(d["ARCHITECTURE.md"], /```mermaid\nflowchart TD[\s\S]*COMP_002 --> COMP_001/);
  assert.equal(JSON.parse(d["DATA_MODEL.json"])[0].id, "ENT-001");
  const tasks = JSON.parse(d["TASKS.json"]);
  assert.deepEqual(tasks.order, ["TASK-001", "TASK-002", "TASK-003"]);
  assert.equal(tasks.tasks.length, 3);
});

// ---------- сховище ----------
test("сховище: пакет зберігається як артефакт engineering_package, чернетку можна змінювати з історією версій", async () => {
  const draft = importPackage();
  const a = await savePackage(draft);
  assert.equal(a.type, "engineering_package");
  assert.equal(a.id, packageArtifactId(draft));
  assert.equal(a.id, "pkg-import@1.0");
  assert.match(a.title, /^Пакет: workbench-import v1\.0 · DRAFT$/);
  assert.equal(a.versions.length, 1);

  const edited = updateDraft(draft, { summary: "Оновлений опис" }, NOW + 20);
  const b = await savePackage(edited);
  assert.equal(b.versions.length, 2, "зміну чернетки збережено в версіях");
  assert.equal((await loadPackage("pkg-import@1.0"))?.summary, "Оновлений опис");
  assert.equal((await savePackage(edited)).versions.length, 2, "збереження без змін не множить версії");
  assert.equal(await loadPackage("nope"), null);
});

test("сховище: зафіксовану версію не можна перезаписати змістом, лише законним переходом статусу", async () => {
  await savePackage(importPackage());
  const review = transition(importPackage(), "REVIEW", { by: "agent", now: NOW + 1 });
  await savePackage(review);
  assert.equal((await loadPackage("pkg-import@1.0"))?.status, "REVIEW");
  const sneaky = { ...review, summary: "Підмінений зміст" };
  await assert.rejects(savePackage(sneaky), /незмінна/);
  const approved = transition(review, "APPROVED", { by: "user", now: NOW + 2 });
  await savePackage(approved);
  await assert.rejects(savePackage({ ...approved, tasks: [] }), /незмінна/);
  await assert.rejects(savePackage({ ...approved, status: "DRAFT" }), /незмінна|неможливий/);
  assert.equal((await loadPackage("pkg-import@1.0"))?.status, "APPROVED");
});

test("сховище: нова версія створюється лише чернеткою; ревізія — окремий запис, список дає останню версію", async () => {
  const approved = transition(transition(importPackage(), "REVIEW", { by: "agent" }), "APPROVED", { by: "user" });
  await assert.rejects(savePackage(approved), /лише як чернетка/);
  await savePackage(importPackage());
  await savePackage(transition(importPackage(), "REVIEW", { by: "agent" }));
  await savePackage(approved);
  const v2 = revise(approved, { now: NOW + 100 });
  await savePackage(v2);
  assert.equal(await db.artifacts.where("type").equals("engineering_package").count(), 2, "дві версії, два записи");
  assert.equal((await loadPackage("pkg-import@1.0"))?.status, "APPROVED", "версія 1.0 не зачеплена");
  const list = await listPackages();
  assert.equal(list.length, 1);
  assert.equal(list[0].version, "1.1");
  const other = newPackage("another", { packageId: "pkg-other", now: NOW + 200 });
  await savePackage(other);
  assert.deepEqual((await listPackages()).map((p) => p.packageId), ["pkg-other", "pkg-import"]);
});

test("версії 1.10 і 1.9 порівнюються числово, а не як рядки", async () => {
  const base = importPackage();
  for (const v of ["1.9", "1.10"]) await savePackage({ ...base, version: v });
  assert.equal((await listPackages())[0].version, "1.10");
});

test("експорт → очищення → імпорт: пакет повертається неушкодженим (тип дозволено схемою імпорту)", async () => {
  const approved = transition(transition(importPackage(), "REVIEW", { by: "agent", now: NOW + 1 }), "APPROVED", { by: "user", now: NOW + 2 });
  await savePackage(importPackage());
  await savePackage(transition(importPackage(), "REVIEW", { by: "agent", now: NOW + 1 }));
  await savePackage(approved);
  const text = JSON.stringify(await exportAll());
  await db.artifacts.clear();
  assert.equal(await loadPackage("pkg-import@1.0"), null);

  const parsed = parseBundle(text);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.bundle.invalid, 0, "жодного запису не відхилено схемою");
  const summary = await importBundle(parsed.bundle);
  assert.equal(summary.artifacts, 1);
  const back = await loadPackage("pkg-import@1.0");
  assert.deepEqual(back, approved, "статус, затвердження й історія збережені");
  // Повторний імпорт нічого не додає й не змінює затверджену версію.
  const again = await importBundle(parseBundle(text).ok ? (parseBundle(text) as any).bundle : parsed.bundle);
  assert.equal(again.artifacts, 0);
  assert.equal((await loadPackage("pkg-import@1.0"))?.status, "APPROVED");
});
