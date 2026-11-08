import { z } from "zod";
import { retrieve } from "../core/retrieval";
import { getSession, setSession } from "../core/session";
import type { ToolDef } from "../core/types";
import { db } from "../db/db";
import { applyEdits, isReplace, type Edit } from "./edits";
import type { EditPreview, ToolHandler } from "./types";

const clip = (s: string, max = 30_000): string => (s.length > max ? s.slice(0, max) + "\n[…відповідь обрізано…]" : s);
const summaryOf = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);
const json = (v: unknown) => ({ content: clip(JSON.stringify(v)) });
const fail = (content: string) => ({ content, isError: true });

/** Артефакт за повним id або за префіксом (у контексті показується `#abcdef12`). */
async function resolveArtifact(idOrPrefix: string) {
  const id = idOrPrefix.replace(/^#/, "").trim();
  const exact = await db.artifacts.get(id);
  if (exact) return exact;
  if (id.length < 6) throw new Error("Занадто короткий ідентифікатор артефакту");
  const found = await db.artifacts.filter((a) => a.id.startsWith(id)).toArray();
  if (found.length === 0) throw new Error(`Артефакт ${id} не знайдено`);
  if (found.length > 1) throw new Error(`Префікс ${id} неоднозначний, потрібен довший`);
  return found[0];
}

// ---------- search_context ----------
const SearchInput = z.object({
  query: z.string().min(1),
  kind: z.enum(["memory", "artifact", "any"]).default("any"),
  topK: z.number().int().min(1).max(10).default(5),
});

const searchContext: ToolHandler = {
  def: {
    name: "search_context",
    description:
      "Шукає у власній пам'яті користувача (факти) та бібліотеці (артефакти) за словами запиту. Використовуй, якщо стартового контексту бракує. Повертає id, які можна передати в read_artifact.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Ключові слова запиту" },
        kind: { type: "string", enum: ["memory", "artifact", "any"] },
        topK: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
    },
  },
  async run(input) {
    const p = SearchInput.parse(input);
    const hits = await retrieve(p.query, { kind: p.kind === "any" ? undefined : p.kind, topK: p.topK });
    const rows = await Promise.all(
      hits.map(async (h) => {
        if (h.kind === "memory") {
          const m = await db.memory.get(h.id);
          return m && { kind: "memory", id: m.id, text: m.text };
        }
        const a = await db.artifacts.get(h.id);
        return a && { kind: "artifact", id: a.id, title: a.title, summary: a.summary, length: a.content.length };
      }),
    );
    return json(rows.filter(Boolean));
  },
};

// ---------- read_artifact ----------
const ReadInput = z.object({
  id: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(20_000).default(20_000),
});

const readArtifact: ToolHandler = {
  def: {
    name: "read_artifact",
    description: "Читає повний текст артефакту з бібліотеки за id (або префіксом із контексту). Довгі тексти читай частинами через offset і limit (у символах).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20000 },
      },
      required: ["id"],
    },
  },
  async run(input) {
    const p = ReadInput.parse(input);
    const a = await resolveArtifact(p.id);
    const end = Math.min(a.content.length, p.offset + p.limit);
    return json({
      id: a.id,
      title: a.title,
      length: a.content.length,
      offset: p.offset,
      content: a.content.slice(p.offset, end),
      nextOffset: end < a.content.length ? end : null,
    });
  },
};

// ---------- apply_edits ----------
const EditSchema = z.union([
  z.object({ find: z.string().min(1), replace: z.string(), reason: z.string().optional() }),
  z.object({ insertAfter: z.string().min(1), text: z.string(), reason: z.string().optional() }),
]);
const EditsInput = z.object({ target: z.string().min(1), edits: z.array(EditSchema).min(1).max(50) });

interface Target {
  label: string;
  content: string;
  save(next: string): Promise<void>;
}

async function loadTarget(target: string): Promise<Target> {
  if (target === "selection") {
    const content = getSession().frag;
    if (!content.trim()) throw new Error("Фрагмент порожній: немає що редагувати");
    return {
      label: "Фрагмент",
      content,
      async save(next) {
        setSession({ frag: next });
      },
    };
  }
  const a = await resolveArtifact(target);
  return {
    label: a.title,
    content: a.content,
    async save(next) {
      const fresh = (await db.artifacts.get(a.id)) ?? a;
      const now = Date.now();
      await db.artifacts.update(a.id, {
        content: next,
        summary: summaryOf(next),
        versions: [...fresh.versions, { at: now, content: next }],
        updatedAt: now,
      });
    },
  };
}

const describeFailed = (failed: { index: number; error: string }[]) => failed.map((f) => `правка ${f.index + 1}: ${f.error}`).join("; ");

const applyEditsTool: ToolHandler = {
  def: {
    name: "apply_edits",
    description:
      "Вносить точкові правки в текст замість переписування. target: «selection» (фрагмент, який вставив користувач) або id артефакту. Кожна правка: {find, replace} або {insertAfter, text}. find/insertAfter мають бути точними й унікальними фрагментами тексту. Користувач побачить diff і підтвердить зміни.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "«selection» або id артефакту" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Точний унікальний фрагмент, який замінюється" },
              replace: { type: "string" },
              insertAfter: { type: "string", description: "Точний унікальний фрагмент, після якого вставляється text" },
              text: { type: "string" },
              reason: { type: "string", description: "Коротко: чому ця правка" },
            },
          },
        },
      },
      required: ["target", "edits"],
    },
  },
  async plan(input) {
    const p = EditsInput.parse(input);
    const t = await loadTarget(p.target);
    const edits = p.edits as Edit[];
    const { failed } = applyEdits(t.content, edits);
    if (failed.length === edits.length) return { error: `Жодну правку не застосовано: ${describeFailed(failed)}. Перечитайте текст і візьміть точні фрагменти.` };
    const bad = new Map(failed.map((f) => [f.index, f.error]));
    const previews: EditPreview[] = edits.map((e, index) => ({
      index,
      kind: isReplace(e) ? "replace" : "insert",
      before: isReplace(e) ? e.find : e.insertAfter,
      after: isReplace(e) ? e.replace : e.text,
      reason: e.reason,
      ok: !bad.has(index),
      error: bad.get(index),
    }));
    return { confirm: { title: "Підтвердьте зміни", subtitle: t.label, edits: previews } };
  },
  async run(input, _ctx, decision) {
    const p = EditsInput.parse(input);
    const t = await loadTarget(p.target); // свіжий вміст: він міг змінитися, поки користувач дивився diff
    const edits = p.edits as Edit[];
    const only = decision?.accepted ? new Set(decision.accepted) : undefined;
    const { result, applied, failed } = applyEdits(t.content, edits, only);
    if (applied.length === 0) return fail(`Жодну правку не застосовано: ${describeFailed(failed) || "користувач не прийняв жодної"}.`);
    await t.save(result);
    const rejected = only ? edits.length - only.size : 0;
    const parts = [`Застосовано правок: ${applied.length} з ${edits.length}.`];
    if (rejected > 0) parts.push(`Користувач відхилив: ${rejected}.`);
    if (failed.length) parts.push(`Не застосовано (${describeFailed(failed)}).`);
    return { content: parts.join(" ") };
  },
};

// ---------- save_artifact ----------
const SaveInput = z.object({
  title: z.string().min(1).max(120),
  content: z.string().min(1),
  type: z.enum(["document", "post", "code", "search_report", "review", "note"]).default("document"),
});

const saveArtifact: ToolHandler = {
  def: {
    name: "save_artifact",
    description: "Зберігає НОВИЙ артефакт у бібліотеку користувача. Викликай, лише якщо користувач просив зберегти результат. Існуючі тексти змінюй через apply_edits.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        type: { type: "string", enum: ["document", "post", "code", "search_report", "review", "note"] },
      },
      required: ["title", "content"],
    },
  },
  async run(input) {
    const p = SaveInput.parse(input);
    const now = Date.now();
    const id = crypto.randomUUID();
    await db.artifacts.add({ id, type: p.type, title: p.title, content: p.content, summary: summaryOf(p.content), versions: [{ at: now, content: p.content }], updatedAt: now });
    return json({ id, title: p.title });
  },
};

// ---------- ask_user ----------
const AskInput = z.object({ question: z.string().min(1), options: z.array(z.string()).max(6).optional() });

const askUser: ToolHandler = {
  def: {
    name: "ask_user",
    description: "Ставить користувачу уточнювальне питання і чекає відповіді. Використовуй, коли без відповіді не можна виконати задачу якісно. Не став більше одного питання за раз.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" }, maxItems: 6 } },
      required: ["question"],
    },
  },
  async run(input, ctx) {
    const p = AskInput.parse(input);
    if (!ctx.ui.ask) return fail("Інтерфейс не може поставити питання.");
    const answer = await ctx.ui.ask({ question: p.question, options: p.options });
    return { content: answer.trim() || "(користувач не відповів)" };
  },
};

export const TOOL_HANDLERS: Record<string, ToolHandler> = Object.fromEntries(
  [searchContext, readArtifact, applyEditsTool, saveArtifact, askUser].map((h) => [h.def.name, h]),
);

export const toolDefs = (...names: string[]): ToolDef[] =>
  names.map((n) => {
    const h = TOOL_HANDLERS[n];
    if (!h) throw new Error(`Невідомий інструмент: ${n}`);
    return h.def;
  });
