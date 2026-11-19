import { z } from "zod";
import {
  Component,
  Entity,
  hasErrors,
  newPackage,
  OpenQuestion,
  PackageError,
  Requirement,
  TaskSpec,
  transition,
  updateDraft,
  validatePackage,
  type EngineeringPackage,
  type Issue,
} from "../engineering/package";
import { listPackages, savePackage } from "../engineering/store";
import type { ToolDef } from "../core/types";
import type { ToolHandler, ToolResult } from "./types";

// Інструменти агента «Інженер»: наповнення чернетки пакета специфікацій по розділах. Кожен розділ окремим викликом,
// код одразу перевіряє його форму й повертає моделі список проблем пакета. Агент змінює лише DRAFT; затвердити пакет
// (APPROVED) він не може: такого інструмента немає, а перехід у REVIEW робиться лише після повної перевірки кодом.

/** Верхні межі розмірів розділів: захист від нескінченних відповідей і роздутого пакета. */
export const PACKAGE_LIMITS = { requirements: 60, components: 40, entities: 40, tasks: 120, questions: 30 } as const;
const MAX_ISSUES_SHOWN = 25;

const ok = (v: unknown): ToolResult => ({ content: JSON.stringify(v) });
const fail = (content: string): ToolResult => ({ content, isError: true });
const shape = (e: z.ZodError): string => `Невірний формат: ${e.issues.slice(0, 8).map((i) => `${i.path.join(".") || "вхід"}: ${i.message}`).join("; ")}`;

async function latest(packageId: string): Promise<EngineeringPackage | null> {
  return (await listPackages()).find((p) => p.packageId === packageId) ?? null;
}

const issueView = (issues: Issue[]) => ({
  errors: issues.filter((i) => i.severity === "error").length,
  warnings: issues.filter((i) => i.severity === "warning").length,
  issues: issues.slice(0, MAX_ISSUES_SHOWN).map((i) => `${i.severity === "error" ? "ПОМИЛКА" : "увага"} ${i.code} ${i.path}: ${i.message}`),
  ...(issues.length > MAX_ISSUES_SHOWN ? { truncated: issues.length - MAX_ISSUES_SHOWN } : {}),
});

const PKG_ID = { type: "string", description: "packageId, який повернув create_package" };
const idField = { packageId: PKG_ID };
const arr = (items: Record<string, unknown>, max: number, description: string) => ({ type: "array", maxItems: max, description, items });
const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });

const def = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef => ({ name, description, input_schema: { type: "object", properties: { ...idField, ...properties }, required: ["packageId", ...required] } });

/** Спільна схема розділу: знайти чернетку, замінити розділ, зберегти, повернути звіт перевірки пакета. */
async function setSection<T>(packageId: string, label: string, count: number, patch: (pkg: EngineeringPackage) => Partial<EngineeringPackage>): Promise<ToolResult> {
  const pkg = await latest(packageId);
  if (!pkg) return fail(`Пакет ${packageId} не знайдено. Створи його через create_package.`);
  let next: EngineeringPackage;
  try {
    next = updateDraft(pkg, patch(pkg) as never);
  } catch (e) {
    if (e instanceof PackageError) return fail(`${e.message} Повідом користувача: зміни можливі лише в чернетці.`);
    throw e;
  }
  await savePackage(next);
  return ok({ saved: label, count, status: next.status, version: next.version, ...issueView(validatePackage(next)) });
}

// ---------- create_package ----------
const createPackage: ToolHandler = {
  def: {
    name: "create_package",
    description: "Створює порожню чернетку пакета специфікацій для проєкту (або модуля). Повертає packageId для решти інструментів. Для кожного projectId може бути лише один активний пакет.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Короткий ідентифікатор проєкту: латиниця, цифри, дефіси (наприклад, workbench-import)" },
        summary: { type: "string", description: "Один-два речення: що проєктується й навіщо. Якщо вхідні документи позначені «@sha», вкажи їх версії." },
      },
      required: ["projectId", "summary"],
    },
  },
  async run(input) {
    const p = z.object({ projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "projectId: латиниця, цифри й дефіси"), summary: z.string().trim().min(5) }).safeParse(input);
    if (!p.success) return fail(shape(p.error));
    const existing = (await listPackages()).find((x) => x.projectId === p.data.projectId && x.status !== "ARCHIVED");
    if (existing) return fail(`Пакет проєкту ${p.data.projectId} уже існує: packageId ${existing.packageId}, версія ${existing.version}, статус ${existing.status}. ${existing.status === "DRAFT" ? "Продовжуй працювати з ним." : "Він зафіксований: нову версію створює користувач."}`);
    const pkg = newPackage(p.data.projectId, { summary: p.data.summary });
    await savePackage(pkg);
    return ok({ packageId: pkg.packageId, version: pkg.version, status: pkg.status, next: "Заповни розділи: set_requirements, set_architecture, set_data_model, set_tasks; потім check_package і request_review." });
  },
};

// ---------- розділи ----------
const setRequirements: ToolHandler = {
  def: def(
    "set_requirements",
    `Замінює розділ вимог (до ${PACKAGE_LIMITS.requirements}). Кожна вимога має критерії прийняття. kind: confirmed (підтверджено користувачем), preference (побажання), assumption (твоє припущення: не видавай за вимогу).`,
    {
      requirements: arr(
        {
          type: "object",
          properties: {
            id: { type: "string", description: "REQ-001, REQ-002, …" },
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "string", enum: ["must", "should", "could"] },
            kind: { type: "string", enum: ["confirmed", "preference", "assumption"] },
            acceptance: arr({ type: "object", properties: { text: { type: "string", description: "Перевірюваний критерій" }, verification: { type: "string", enum: ["test", "manual", "inspection"] } }, required: ["text", "verification"] }, 12, "Критерії прийняття"),
          },
          required: ["id", "title", "description", "priority", "kind", "acceptance"],
        },
        PACKAGE_LIMITS.requirements,
        "Вимоги",
      ),
    },
    ["requirements"],
  ),
  async run(input) {
    const p = z.object({ packageId: z.string().min(1), requirements: z.array(Requirement).max(PACKAGE_LIMITS.requirements) }).safeParse(input);
    return p.success ? setSection(p.data.packageId, "requirements", p.data.requirements.length, () => ({ requirements: p.data.requirements })) : fail(shape(p.error));
  },
};

const setArchitecture: ToolHandler = {
  def: def(
    "set_architecture",
    `Замінює опис архітектури (Markdown: межі системи, потоки даних, ключові рішення) і компоненти (до ${PACKAGE_LIMITS.components}). Компонент має відповідальність і залежності від інших компонентів.`,
    {
      architecture: { type: "string", description: "Markdown: межі системи, потоки даних, ключові рішення" },
      components: arr(
        {
          type: "object",
          properties: {
            id: { type: "string", description: "COMP-001, COMP-002, …" },
            name: { type: "string" },
            purpose: { type: "string" },
            responsibilities: strs("Що компонент робить"),
            inputs: strs("Що отримує"),
            outputs: strs("Що віддає"),
            dependsOn: strs("COMP-id компонентів, від яких залежить"),
            errors: strs("Помилкові ситуації"),
          },
          required: ["id", "name", "purpose", "responsibilities", "inputs", "outputs", "dependsOn", "errors"],
        },
        PACKAGE_LIMITS.components,
        "Компоненти",
      ),
    },
    ["architecture", "components"],
  ),
  async run(input) {
    const p = z.object({ packageId: z.string().min(1), architecture: z.string().trim().min(10), components: z.array(Component).max(PACKAGE_LIMITS.components) }).safeParse(input);
    return p.success ? setSection(p.data.packageId, "architecture", p.data.components.length, () => ({ architecture: p.data.architecture, components: p.data.components })) : fail(shape(p.error));
  },
};

const setDataModel: ToolHandler = {
  def: def(
    "set_data_model",
    `Замінює модель даних (до ${PACKAGE_LIMITS.entities} сутностей). Для проєкту без даних передай порожній масив. Типи й назви полів мають збігатися з реальною схемою, якщо проєкт уже існує.`,
    {
      entities: arr(
        {
          type: "object",
          properties: {
            id: { type: "string", description: "ENT-001, ENT-002, …" },
            name: { type: "string" },
            description: { type: "string" },
            fields: arr({ type: "object", properties: { name: { type: "string" }, type: { type: "string" }, required: { type: "boolean" }, description: { type: "string" } }, required: ["name", "type", "required"] }, 60, "Поля"),
            relations: arr({ type: "object", properties: { to: { type: "string", description: "ENT-id" }, cardinality: { type: "string", enum: ["1:1", "1:N", "N:N"] } }, required: ["to", "cardinality"] }, 20, "Зв'язки"),
          },
          required: ["id", "name", "description", "fields", "relations"],
        },
        PACKAGE_LIMITS.entities,
        "Сутності",
      ),
    },
    ["entities"],
  ),
  async run(input) {
    const p = z.object({ packageId: z.string().min(1), entities: z.array(Entity).max(PACKAGE_LIMITS.entities) }).safeParse(input);
    return p.success ? setSection(p.data.packageId, "dataModel", p.data.entities.length, () => ({ dataModel: p.data.entities })) : fail(shape(p.error));
  },
};

const setTasks: ToolHandler = {
  def: def(
    "set_tasks",
    `Замінює розділ задач (до ${PACKAGE_LIMITS.tasks}). Кожна задача мала, посилається на вимоги й компоненти, має залежності, критерії прийняття та спосіб перевірки (команда або кроки). Кожна обов'язкова вимога має бути покрита хоча б однією задачею.`,
    {
      tasks: arr(
        {
          type: "object",
          properties: {
            id: { type: "string", description: "TASK-001, TASK-002, …" },
            title: { type: "string" },
            description: { type: "string" },
            requirements: strs("REQ-id вимог, які реалізує задача"),
            components: strs("COMP-id компонентів, які вона змінює"),
            dependsOn: strs("TASK-id задач, які мають бути виконані раніше"),
            files: strs("Очікувані файли (якщо відомі)"),
            acceptance: strs("Критерії прийняття задачі"),
            verification: { type: "string", description: "Як перевірити: команда (наприклад, npm run check) або кроки" },
          },
          required: ["id", "title", "description", "requirements", "components", "dependsOn", "files", "acceptance", "verification"],
        },
        PACKAGE_LIMITS.tasks,
        "Задачі",
      ),
    },
    ["tasks"],
  ),
  async run(input) {
    const p = z.object({ packageId: z.string().min(1), tasks: z.array(TaskSpec).max(PACKAGE_LIMITS.tasks) }).safeParse(input);
    return p.success ? setSection(p.data.packageId, "tasks", p.data.tasks.length, () => ({ tasks: p.data.tasks })) : fail(shape(p.error));
  },
};

const setOpenQuestions: ToolHandler = {
  def: def(
    "set_open_questions",
    "Замінює розділ відкритих питань. blocking: true для питань, без відповіді на які пакет не можна віддавати на перегляд; відповідь записується в resolution. Не приховуй невизначеність, а винось її сюди.",
    { questions: arr({ type: "object", properties: { id: { type: "string", description: "Q-001, Q-002, …" }, text: { type: "string" }, blocking: { type: "boolean" }, resolution: { type: "string" } }, required: ["id", "text", "blocking"] }, PACKAGE_LIMITS.questions, "Питання") },
    ["questions"],
  ),
  async run(input) {
    const p = z.object({ packageId: z.string().min(1), questions: z.array(OpenQuestion).max(PACKAGE_LIMITS.questions) }).safeParse(input);
    return p.success ? setSection(p.data.packageId, "openQuestions", p.data.questions.length, () => ({ openQuestions: p.data.questions })) : fail(shape(p.error));
  },
};

// ---------- перевірка і перегляд ----------
const checkPackage: ToolHandler = {
  def: def("check_package", "Перевіряє пакет кодом: посилання між вимогами, компонентами й задачами, цикли залежностей, покриття вимог, повнота. Нічого не змінює. Виклич перед request_review.", {}, []),
  async run(input) {
    const p = z.object({ packageId: z.string().min(1) }).safeParse(input);
    if (!p.success) return fail(shape(p.error));
    const pkg = await latest(p.data.packageId);
    if (!pkg) return fail(`Пакет ${p.data.packageId} не знайдено.`);
    const issues = validatePackage(pkg, { complete: true });
    return ok({ status: pkg.status, version: pkg.version, readyForReview: !hasErrors(issues), counts: { requirements: pkg.requirements.length, components: pkg.components.length, entities: pkg.dataModel.length, tasks: pkg.tasks.length, openQuestions: pkg.openQuestions.length }, ...issueView(issues) });
  },
};

const requestReview: ToolHandler = {
  def: def("request_review", "Передає чернетку користувачеві на перегляд (DRAFT → REVIEW) лише якщо перевірка пройшла без помилок. Після цього пакет незмінний; затверджує його тільки користувач, ти цього зробити не можеш.", { note: { type: "string", description: "Коротка примітка для користувача" } }, []),
  async run(input) {
    const p = z.object({ packageId: z.string().min(1), note: z.string().optional() }).safeParse(input);
    if (!p.success) return fail(shape(p.error));
    const pkg = await latest(p.data.packageId);
    if (!pkg) return fail(`Пакет ${p.data.packageId} не знайдено.`);
    try {
      const next = transition(pkg, "REVIEW", { by: "agent", note: p.data.note ?? "Передано на перегляд" });
      await savePackage(next);
      return ok({ status: next.status, version: next.version, message: "Пакет передано користувачеві на перегляд. Затвердити його може лише користувач." });
    } catch (e) {
      if (e instanceof PackageError) return fail(e.message);
      throw e;
    }
  },
};

export const ENGINEERING_HANDLERS: ToolHandler[] = [createPackage, setRequirements, setArchitecture, setDataModel, setTasks, setOpenQuestions, checkPackage, requestReview];
export const ENGINEERING_TOOL_NAMES = ENGINEERING_HANDLERS.map((h) => h.def.name);
