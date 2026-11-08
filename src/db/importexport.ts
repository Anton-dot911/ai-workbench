import { z } from "zod";
import type { Artifact, MemoryItem, Profile, Run } from "../core/types";
import { db, getProfile, saveProfile } from "./db";

// Імпорт бази: приймає файл експорту (`exportAll`) або спрощений пакет (профіль + факти без id).
// Імпорт лише додає: наявні записи (за id або однаковим текстом факту) пропускаються, нічого не видаляється.

const Str = z.string();
const StrList = z.array(z.string());

const ProfileSchema = z.object({
  name: Str.optional(),
  language: Str.optional(),
  tone: Str.optional(),
  audience: Str.optional(),
  expertise: StrList.optional(),
  brandWords: StrList.optional(),
  codingPrefs: z.object({ stack: StrList.default([]), style: Str.default("") }).optional(),
  privateFields: StrList.optional(),
});

const MemorySchema = z.object({
  id: Str.optional(),
  text: Str.min(1),
  tags: StrList.default([]),
  source: z.enum(["user", "agent"]).default("user"),
  createdAt: z.number().optional(),
  pinned: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
});

const ArtifactSchema = z.object({
  id: Str.min(1),
  type: z.enum(["document", "post", "code", "search_report", "review", "note"]),
  title: Str,
  content: Str,
  summary: Str.optional(),
  workspaceId: Str.optional(),
  parentRunId: Str.optional(),
  versions: z.array(z.object({ at: z.number(), content: Str })).optional(),
  updatedAt: z.number().optional(),
});

const RunSchema = z.object({
  id: Str.min(1),
  agentId: Str,
  input: Str,
  output: Str,
  contextSnapshot: z.object({ sources: z.array(z.any()), stable: Str, relevant: Str, operative: Str, tokenEstimate: z.number() }).passthrough(),
  usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), costUsd: z.number() }),
  createdAt: z.number(),
  chainId: Str.optional(),
  steps: z.number().optional(),
  toolCalls: z.array(z.object({ name: Str, ok: z.boolean() })).optional(),
});

export interface Bundle {
  profile?: z.infer<typeof ProfileSchema>;
  memory: z.infer<typeof MemorySchema>[];
  artifacts: z.infer<typeof ArtifactSchema>[];
  runs: Run[];
  /** Записи, що не пройшли перевірку формату. */
  invalid: number;
}

export interface ImportSummary {
  profile: boolean;
  memory: number;
  artifacts: number;
  runs: number;
  skipped: number;
}

function pick<T>(schema: z.ZodType<T>, items: unknown): { ok: T[]; bad: number } {
  const ok: T[] = [];
  let bad = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const r = schema.safeParse(it);
    if (r.success) ok.push(r.data);
    else bad++;
  }
  return { ok, bad };
}

/** Розбирає текст пакета. Повертає помилку людською мовою, якщо це не JSON або не схоже на пакет. */
export function parseBundle(text: string): { ok: true; bundle: Bundle } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Це не JSON. Вставте вміст файлу експорту або пакет цілком." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Очікується JSON-об'єкт із полями profile, memory, artifacts, runs." };
  const o = raw as Record<string, unknown>;
  if (!("profile" in o || "memory" in o || "artifacts" in o || "runs" in o)) return { ok: false, error: "У пакеті немає ні профілю, ні фактів, ні артефактів, ні запусків." };

  const profileRaw = Array.isArray(o.profile) ? o.profile[0] : o.profile;
  const profile = profileRaw === undefined ? undefined : ProfileSchema.safeParse(profileRaw);
  const memory = pick(MemorySchema, o.memory);
  const artifacts = pick(ArtifactSchema, o.artifacts);
  const runs = pick(RunSchema, o.runs);
  const bundle: Bundle = {
    profile: profile?.success ? profile.data : undefined,
    memory: memory.ok,
    artifacts: artifacts.ok,
    runs: runs.ok as unknown as Run[],
    invalid: memory.bad + artifacts.bad + runs.bad + (profile && !profile.success ? 1 : 0),
  };
  if (!bundle.profile && !bundle.memory.length && !bundle.artifacts.length && !bundle.runs.length) {
    return { ok: false, error: "У пакеті немає жодного коректного запису." };
  }
  return { ok: true, bundle };
}

/** Короткий опис для попереднього перегляду перед імпортом. */
export function describeBundle(b: Bundle): string {
  const parts: string[] = [];
  if (b.profile) parts.push("профіль");
  if (b.memory.length) parts.push(`фактів: ${b.memory.length}`);
  if (b.artifacts.length) parts.push(`артефактів: ${b.artifacts.length}`);
  if (b.runs.length) parts.push(`запусків: ${b.runs.length}`);
  return parts.join(", ") + (b.invalid ? ` · пропущено через помилки формату: ${b.invalid}` : "");
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export async function importBundle(b: Bundle): Promise<ImportSummary> {
  const summary: ImportSummary = { profile: false, memory: 0, artifacts: 0, runs: 0, skipped: b.invalid };

  if (b.profile) {
    const cur = await getProfile();
    const p = b.profile;
    const next: Profile = { ...cur };
    if (p.name) next.name = p.name;
    if (p.language) next.language = p.language;
    if (p.tone) next.tone = p.tone;
    if (p.audience) next.audience = p.audience;
    if (p.expertise?.length) next.expertise = p.expertise;
    if (p.brandWords?.length) next.brandWords = p.brandWords;
    if (p.codingPrefs && (p.codingPrefs.stack.length || p.codingPrefs.style)) next.codingPrefs = p.codingPrefs;
    if (p.privateFields) next.privateFields = p.privateFields;
    await saveProfile(next);
    summary.profile = true;
  }

  const facts = await db.memory.toArray();
  const ids = new Set(facts.map((m) => m.id));
  const texts = new Set(facts.map((m) => norm(m.text)));
  for (const m of b.memory) {
    if ((m.id && ids.has(m.id)) || texts.has(norm(m.text))) {
      summary.skipped++;
      continue;
    }
    const item: MemoryItem = {
      id: m.id ?? crypto.randomUUID(),
      text: m.text.trim(),
      tags: m.tags,
      source: m.source,
      createdAt: m.createdAt ?? Date.now(),
      pinned: m.pinned === true || m.pinned === 1 ? 1 : 0,
    };
    await db.memory.add(item);
    ids.add(item.id);
    texts.add(norm(item.text));
    summary.memory++;
  }

  for (const a of b.artifacts) {
    if (await db.artifacts.get(a.id)) {
      summary.skipped++;
      continue;
    }
    const now = a.updatedAt ?? Date.now();
    const art: Artifact = {
      id: a.id,
      type: a.type,
      title: a.title,
      content: a.content,
      summary: a.summary ?? a.content.replace(/\s+/g, " ").trim().slice(0, 200),
      workspaceId: a.workspaceId,
      parentRunId: a.parentRunId,
      versions: a.versions?.length ? a.versions : [{ at: now, content: a.content }],
      updatedAt: now,
    };
    await db.artifacts.add(art);
    summary.artifacts++;
  }

  for (const r of b.runs) {
    if (await db.runs.get(r.id)) {
      summary.skipped++;
      continue;
    }
    await db.runs.add(r);
    summary.runs++;
  }
  return summary;
}
