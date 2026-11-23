import { z } from "zod";

// Пакет інженерних специфікацій (Engineering Package): вимоги, архітектура з компонентами, модель даних і задачі.
// Це структуровані дані, а не просто текст, тому повноту, посилання між частинами й життєвий цикл перевіряє код.
// Документи REQUIREMENTS.md / ARCHITECTURE.md / DATA_MODEL.json / TASKS.json відтворюються з цих даних (`renderDocuments`).

export const PACKAGE_SCHEMA_VERSION = 1;

export const PACKAGE_STATUSES = ["DRAFT", "REVIEW", "APPROVED", "IN_IMPLEMENTATION", "CHANGE_REQUESTED", "COMPLETED", "ARCHIVED"] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-\\d{3,}$`), `Ідентифікатор має вигляд ${prefix}-001`);
const text = (min = 1) => z.string().trim().min(min);

export const Requirement = z.object({
  id: id("REQ"),
  title: text(3),
  description: text(),
  priority: z.enum(["must", "should", "could"]),
  /** confirmed: підтверджено користувачем; preference: побажання; assumption: припущення (не видавати за вимогу). */
  kind: z.enum(["confirmed", "preference", "assumption"]),
  acceptance: z.array(z.object({ text: text(3), verification: z.enum(["test", "manual", "inspection"]) })),
});
export type Requirement = z.infer<typeof Requirement>;

export const Component = z.object({
  id: id("COMP"),
  name: text(2),
  purpose: text(),
  responsibilities: z.array(text()),
  inputs: z.array(text()),
  outputs: z.array(text()),
  dependsOn: z.array(id("COMP")),
  errors: z.array(text()),
});
export type Component = z.infer<typeof Component>;

export const Entity = z.object({
  id: id("ENT"),
  name: text(2),
  description: text(),
  fields: z.array(z.object({ name: text(), type: text(), required: z.boolean(), description: z.string().optional() })),
  relations: z.array(z.object({ to: id("ENT"), cardinality: z.enum(["1:1", "1:N", "N:N"]) })),
});
export type Entity = z.infer<typeof Entity>;

export const TaskSpec = z.object({
  id: id("TASK"),
  title: text(3),
  description: text(),
  requirements: z.array(id("REQ")),
  components: z.array(id("COMP")),
  dependsOn: z.array(id("TASK")),
  files: z.array(text()),
  acceptance: z.array(text()),
  /** Як перевірити: команда або кроки (наприклад, «npm run check»). */
  verification: z.string().trim(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

export const OpenQuestion = z.object({ id: id("Q"), text: text(), blocking: z.boolean(), resolution: z.string().optional() });
export type OpenQuestion = z.infer<typeof OpenQuestion>;

export const EngineeringPackage = z.object({
  schema: z.literal(PACKAGE_SCHEMA_VERSION),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "projectId: латиниця, цифри й дефіси"),
  /** Незмінний ідентифікатор пакета; кожна версія це окремий запис із тим самим packageId. */
  packageId: text(),
  version: z.string().regex(/^\d+\.\d+$/, "Версія має вигляд 1.0"),
  status: z.enum(PACKAGE_STATUSES),
  createdAt: z.number(),
  updatedAt: z.number(),
  summary: z.string(),
  /** Markdown: межі системи, потоки даних, рішення. */
  architecture: z.string(),
  requirements: z.array(Requirement),
  components: z.array(Component),
  dataModel: z.array(Entity),
  tasks: z.array(TaskSpec),
  openQuestions: z.array(OpenQuestion),
  approval: z.object({ approvedAt: z.number(), note: z.string().optional() }).optional(),
  /** Версія, яку замінює ця (для ревізій). */
  supersedes: z.string().optional(),
  history: z.array(z.object({ at: z.number(), version: z.string(), status: z.enum(PACKAGE_STATUSES), note: z.string() })),
});
export type EngineeringPackage = z.infer<typeof EngineeringPackage>;

export function parsePackage(raw: unknown): { ok: true; package: EngineeringPackage } | { ok: false; error: string } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Пакет не є коректним JSON." };
    }
  }
  const p = EngineeringPackage.safeParse(value);
  return p.success ? { ok: true, package: p.data } : { ok: false, error: p.error.issues.map((i) => `${i.path.join(".") || "пакет"}: ${i.message}`).join("; ") };
}

export function newPackage(projectId: string, opts: { packageId?: string; now?: number; summary?: string } = {}): EngineeringPackage {
  const now = opts.now ?? Date.now();
  return {
    schema: PACKAGE_SCHEMA_VERSION,
    projectId,
    packageId: opts.packageId ?? crypto.randomUUID(),
    version: "1.0",
    status: "DRAFT",
    createdAt: now,
    updatedAt: now,
    summary: opts.summary ?? "",
    architecture: "",
    requirements: [],
    components: [],
    dataModel: [],
    tasks: [],
    openQuestions: [],
    history: [{ at: now, version: "1.0", status: "DRAFT", note: "Створено" }],
  };
}

// ---------- перевірка кодом ----------

export interface Issue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

/** Скільки непорожніх (після trim) рядків: у пакеті, що не пройшов розбір схеми, пробіли не мають вважатися змістом. */
const filled = (xs: string[]): number => xs.filter((x) => x.trim()).length;
const dupes = (ids: string[]): string[] => ids.filter((x, i) => ids.indexOf(x) !== i);

/** Перший цикл у графі залежностей (список вузлів по колу) або null. */
export function findCycle(deps: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const d of deps.get(n) ?? []) {
      if (!deps.has(d)) continue;
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of deps.keys()) if (!state.has(n)) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/**
 * Семантична перевірка пакета. `complete: true` додає вимоги повноти (для переходу в REVIEW/APPROVED):
 * непорожні вимоги, компоненти й задачі, опис архітектури, жодного невирішеного блокувального питання.
 */
export function validatePackage(pkg: EngineeringPackage, opts: { complete?: boolean } = {}): Issue[] {
  const out: Issue[] = [];
  const add = (severity: Issue["severity"], code: string, path: string, message: string) => out.push({ severity, code, path, message });

  for (const [kind, ids] of [["REQ", pkg.requirements.map((r) => r.id)], ["COMP", pkg.components.map((c) => c.id)], ["ENT", pkg.dataModel.map((e) => e.id)], ["TASK", pkg.tasks.map((t) => t.id)], ["Q", pkg.openQuestions.map((q) => q.id)]] as const) {
    for (const d of new Set(dupes([...ids]))) add("error", "DUP_ID", kind, `Ідентифікатор ${d} повторюється.`);
  }

  const reqs = new Map(pkg.requirements.map((r) => [r.id, r]));
  const comps = new Map(pkg.components.map((c) => [c.id, c]));
  const ents = new Set(pkg.dataModel.map((e) => e.id));
  const tasks = new Map(pkg.tasks.map((t) => [t.id, t]));

  for (const r of pkg.requirements) {
    if (filled(r.acceptance.map((a) => a.text)) === 0) add("error", "REQ_NO_ACCEPTANCE", r.id, `${r.id}: немає критеріїв прийняття.`);
    if (r.kind === "assumption" && r.priority === "must") add("warning", "REQ_ASSUMPTION_MUST", r.id, `${r.id}: обов'язкова вимога лише на припущенні, потребує підтвердження користувача.`);
  }

  for (const c of pkg.components) {
    if (filled(c.responsibilities) === 0) add("error", "COMP_NO_RESPONSIBILITY", c.id, `${c.id}: не описано відповідальність.`);
    for (const d of c.dependsOn) {
      if (d === c.id) add("error", "COMP_SELF_DEP", c.id, `${c.id}: залежить від самого себе.`);
      else if (!comps.has(d)) add("error", "COMP_UNKNOWN_DEP", c.id, `${c.id}: невідома залежність ${d}.`);
    }
  }
  const compCycle = findCycle(new Map(pkg.components.map((c) => [c.id, c.dependsOn.filter((d) => d !== c.id)])));
  if (compCycle) add("error", "COMP_CYCLE", compCycle[0], `Цикл залежностей компонентів: ${compCycle.join(" → ")}.`);

  for (const e of pkg.dataModel) {
    if (e.fields.length === 0) add("error", "ENT_NO_FIELDS", e.id, `${e.id}: немає полів.`);
    for (const f of new Set(dupes(e.fields.map((x) => x.name)))) add("error", "ENT_DUP_FIELD", e.id, `${e.id}: поле «${f}» повторюється.`);
    for (const rel of e.relations) if (!ents.has(rel.to)) add("error", "ENT_UNKNOWN_RELATION", e.id, `${e.id}: зв'язок із невідомою сутністю ${rel.to}.`);
  }

  const coveredReqs = new Set<string>();
  const usedComps = new Set<string>();
  for (const t of pkg.tasks) {
    if (t.requirements.length === 0) add("error", "TASK_NO_REQUIREMENT", t.id, `${t.id}: не посилається на жодну вимогу.`);
    for (const r of t.requirements) {
      if (!reqs.has(r)) add("error", "TASK_UNKNOWN_REQUIREMENT", t.id, `${t.id}: невідома вимога ${r}.`);
      else coveredReqs.add(r);
    }
    for (const c of t.components) {
      if (!comps.has(c)) add("error", "TASK_UNKNOWN_COMPONENT", t.id, `${t.id}: невідомий компонент ${c}.`);
      else usedComps.add(c);
    }
    for (const d of t.dependsOn) {
      if (d === t.id) add("error", "TASK_SELF_DEP", t.id, `${t.id}: залежить від самої себе.`);
      else if (!tasks.has(d)) add("error", "TASK_UNKNOWN_DEP", t.id, `${t.id}: невідома залежність ${d}.`);
    }
    if (!t.verification.trim()) add("error", "TASK_NO_VERIFICATION", t.id, `${t.id}: не вказано, як перевірити виконання.`);
    if (filled(t.acceptance) === 0) add("error", "TASK_NO_ACCEPTANCE", t.id, `${t.id}: немає критеріїв прийняття.`);
    const known = t.requirements.map((r) => reqs.get(r)).filter((r): r is Requirement => !!r);
    if (known.length > 0 && known.every((r) => r.kind === "assumption")) add("warning", "TASK_ONLY_ASSUMPTIONS", t.id, `${t.id}: спирається лише на непідтверджені припущення.`);
  }
  const taskCycle = findCycle(new Map(pkg.tasks.map((t) => [t.id, t.dependsOn.filter((d) => d !== t.id)])));
  if (taskCycle) add("error", "TASK_CYCLE", taskCycle[0], `Цикл залежностей задач: ${taskCycle.join(" → ")}.`);

  for (const r of pkg.requirements) {
    if (!coveredReqs.has(r.id)) add(r.priority === "must" ? "error" : "warning", "REQ_UNCOVERED", r.id, `${r.id} (${r.priority}): жодна задача її не реалізує.`);
  }
  for (const c of pkg.components) if (!usedComps.has(c.id)) add("warning", "COMP_UNUSED", c.id, `${c.id}: жодна задача не змінює цей компонент.`);

  if (opts.complete) {
    if (pkg.requirements.length === 0) add("error", "EMPTY_REQUIREMENTS", "requirements", "Немає жодної вимоги.");
    if (pkg.components.length === 0) add("error", "EMPTY_COMPONENTS", "components", "Немає жодного компонента.");
    if (pkg.tasks.length === 0) add("error", "EMPTY_TASKS", "tasks", "Немає жодної задачі.");
    if (!pkg.architecture.trim()) add("error", "EMPTY_ARCHITECTURE", "architecture", "Немає опису архітектури.");
    if (pkg.dataModel.length === 0) add("warning", "EMPTY_DATA_MODEL", "dataModel", "Модель даних порожня (прийнятно лише для проєкту без даних).");
    for (const q of pkg.openQuestions) if (q.blocking && !q.resolution?.trim()) add("error", "BLOCKING_QUESTION", q.id, `${q.id}: невирішене блокувальне питання: ${q.text}`);
  }
  return out;
}

export const hasErrors = (issues: Issue[]): boolean => issues.some((i) => i.severity === "error");

// ---------- життєвий цикл ----------

const TRANSITIONS: Record<PackageStatus, PackageStatus[]> = {
  DRAFT: ["REVIEW", "ARCHIVED"],
  REVIEW: ["DRAFT", "APPROVED", "ARCHIVED"],
  APPROVED: ["IN_IMPLEMENTATION", "CHANGE_REQUESTED", "ARCHIVED"],
  IN_IMPLEMENTATION: ["CHANGE_REQUESTED", "COMPLETED", "ARCHIVED"],
  CHANGE_REQUESTED: ["ARCHIVED"],
  COMPLETED: ["CHANGE_REQUESTED", "ARCHIVED"],
  ARCHIVED: [],
};

export const canTransition = (from: PackageStatus, to: PackageStatus): boolean => TRANSITIONS[from].includes(to);
/** Змінювати вміст можна лише в чернетці; решта статусів це зафіксована версія. */
export const isEditable = (status: PackageStatus): boolean => status === "DRAFT";

export class PackageError extends Error {}

type Spec = Pick<EngineeringPackage, "summary" | "architecture" | "requirements" | "components" | "dataModel" | "tasks" | "openQuestions">;
const specOf = (p: EngineeringPackage): Spec => ({ summary: p.summary, architecture: p.architecture, requirements: p.requirements, components: p.components, dataModel: p.dataModel, tasks: p.tasks, openQuestions: p.openQuestions });
export const sameSpec = (a: EngineeringPackage, b: EngineeringPackage): boolean => JSON.stringify(specOf(a)) === JSON.stringify(specOf(b));

/** Змінює вміст чернетки. Для зафіксованої версії кидає помилку: потрібна ревізія (`revise`). */
export function updateDraft(pkg: EngineeringPackage, patch: Partial<Spec>, now = Date.now()): EngineeringPackage {
  if (!isEditable(pkg.status)) throw new PackageError(`Пакет зі статусом ${pkg.status} незмінний: створіть нову версію (revise).`);
  return { ...pkg, ...patch, updatedAt: now };
}

/**
 * Перехід статусу. REVIEW вимагає повного пакета без помилок перевірки; APPROVED додатково може виконати лише користувач
 * (`by: "user"`): агент пакет не затверджує.
 */
export function transition(pkg: EngineeringPackage, to: PackageStatus, opts: { by: "user" | "agent"; now?: number; note?: string }): EngineeringPackage {
  const now = opts.now ?? Date.now();
  if (!canTransition(pkg.status, to)) throw new PackageError(`Перехід ${pkg.status} → ${to} неможливий.`);
  if (to === "APPROVED" && opts.by !== "user") throw new PackageError("Затвердити пакет може лише користувач.");
  if (to === "REVIEW" || to === "APPROVED") {
    const errors = validatePackage(pkg, { complete: true }).filter((i) => i.severity === "error");
    if (errors.length) throw new PackageError(`Пакет не готовий (${errors.length} помилок): ${errors.slice(0, 3).map((e) => e.message).join(" ")}`);
  }
  const next: EngineeringPackage = { ...pkg, status: to, updatedAt: now, history: [...pkg.history, { at: now, version: pkg.version, status: to, note: opts.note ?? "" }] };
  if (to === "APPROVED") next.approval = { approvedAt: now, ...(opts.note ? { note: opts.note } : {}) };
  return next;
}

/** Нова версія зафіксованого пакета: копія вмісту як чернетка з номером версії +1. Попередня версія не змінюється. */
export function revise(pkg: EngineeringPackage, opts: { now?: number; note?: string } = {}): EngineeringPackage {
  if (isEditable(pkg.status)) throw new PackageError("Чернетку можна редагувати без нової версії.");
  const now = opts.now ?? Date.now();
  const [major, minor] = pkg.version.split(".").map(Number);
  const version = `${major}.${minor + 1}`;
  const copy: EngineeringPackage = JSON.parse(JSON.stringify(pkg));
  delete copy.approval;
  return { ...copy, version, status: "DRAFT", createdAt: now, updatedAt: now, supersedes: pkg.version, history: [...pkg.history, { at: now, version, status: "DRAFT", note: opts.note ?? `Ревізія версії ${pkg.version}` }] };
}

// ---------- порядок і простежуваність ----------

/** Задачі в порядку залежностей (стабільно за id). Кидає помилку, якщо є цикл. */
export function taskOrder(pkg: EngineeringPackage): TaskSpec[] {
  const left = new Map(pkg.tasks.map((t) => [t.id, new Set(t.dependsOn.filter((d) => d !== t.id && pkg.tasks.some((x) => x.id === d)))]));
  const byId = new Map(pkg.tasks.map((t) => [t.id, t]));
  const out: TaskSpec[] = [];
  while (left.size) {
    const ready = [...left.entries()].filter(([, d]) => d.size === 0).map(([k]) => k).sort();
    if (ready.length === 0) throw new PackageError(`Цикл залежностей задач: ${[...left.keys()].join(", ")}.`);
    const next = ready[0];
    out.push(byId.get(next)!);
    left.delete(next);
    for (const d of left.values()) d.delete(next);
  }
  return out;
}

/** Задачі, які можна починати: усі залежності виконані. */
export const readyTasks = (pkg: EngineeringPackage, done: string[]): TaskSpec[] => taskOrder(pkg).filter((t) => !done.includes(t.id) && t.dependsOn.every((d) => done.includes(d)));

export interface TraceRow {
  requirement: string;
  title: string;
  components: string[];
  tasks: string[];
  verification: ("test" | "manual" | "inspection")[];
}

/** Вимога → компоненти й задачі → способи перевірки. */
export function traceability(pkg: EngineeringPackage): TraceRow[] {
  return pkg.requirements.map((r) => {
    const ts = pkg.tasks.filter((t) => t.requirements.includes(r.id));
    return { requirement: r.id, title: r.title, components: [...new Set(ts.flatMap((t) => t.components))].sort(), tasks: ts.map((t) => t.id), verification: [...new Set(r.acceptance.map((a) => a.verification))] };
  });
}

// ---------- документи ----------

/** TASKS.json: порядок виконання й задачі. Чернетка з циклом залежностей не ламає перегляд: порядок замінюється переліком задач і описом помилки. */
function tasksDocument(pkg: EngineeringPackage): { order: string[]; orderError?: string; tasks: TaskSpec[] } {
  try {
    return { order: taskOrder(pkg).map((t) => t.id), tasks: pkg.tasks };
  } catch (e) {
    return { order: pkg.tasks.map((t) => t.id), orderError: e instanceof Error ? e.message : String(e), tasks: pkg.tasks };
  }
}

/** Відтворює документи пакета з даних (для перегляду й передачі кодеру). */
export function renderDocuments(pkg: EngineeringPackage): Record<string, string> {
  const head = `Пакет ${pkg.projectId} · версія ${pkg.version} · ${pkg.status}`;
  const requirements = [
    `# Вимоги\n\n${head}\n`,
    ...pkg.requirements.map((r) => [`## ${r.id} · ${r.title}`, `Пріоритет: ${r.priority} · статус вимоги: ${r.kind}`, "", r.description, "", "Критерії прийняття:", ...r.acceptance.map((a) => `- [${a.verification}] ${a.text}`)].join("\n")),
    pkg.openQuestions.length ? ["## Відкриті питання", ...pkg.openQuestions.map((q) => `- ${q.id}${q.blocking ? " (блокувальне)" : ""}: ${q.text}${q.resolution ? ` → ${q.resolution}` : ""}`)].join("\n") : "",
  ].filter(Boolean).join("\n\n");

  const graph = ["```mermaid", "flowchart TD", ...pkg.components.flatMap((c) => [`  ${c.id.replace("-", "_")}["${c.id} ${c.name.replace(/"/g, "'")}"]`, ...c.dependsOn.map((d) => `  ${c.id.replace("-", "_")} --> ${d.replace("-", "_")}`)]), "```"].join("\n");
  const architecture = [
    `# Архітектура\n\n${head}\n`,
    pkg.architecture.trim(),
    "## Компоненти",
    ...pkg.components.map((c) => [`### ${c.id} · ${c.name}`, c.purpose, "", "Відповідальність:", ...c.responsibilities.map((x) => `- ${x}`), c.inputs.length ? `Вхід: ${c.inputs.join("; ")}` : "", c.outputs.length ? `Вихід: ${c.outputs.join("; ")}` : "", c.dependsOn.length ? `Залежить від: ${c.dependsOn.join(", ")}` : "", c.errors.length ? `Помилки: ${c.errors.join("; ")}` : ""].filter((x) => x !== "").join("\n")),
    "## Залежності",
    graph,
  ].filter(Boolean).join("\n\n");

  return {
    "REQUIREMENTS.md": requirements,
    "ARCHITECTURE.md": architecture,
    "DATA_MODEL.json": JSON.stringify(pkg.dataModel, null, 2),
    "TASKS.json": JSON.stringify(tasksDocument(pkg), null, 2),
  };
}
