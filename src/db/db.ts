import Dexie, { type Table } from "dexie";
import type { Artifact, MemoryItem, Profile, Run } from "../core/types";
import { bumpDataVersion } from "./changes";

class WorkbenchDB extends Dexie {
  profile!: Table<Profile, string>;
  memory!: Table<MemoryItem, string>;
  artifacts!: Table<Artifact, string>;
  runs!: Table<Run, string>;

  constructor() {
    super("workbench");
    this.version(1).stores({
      profile: "id",
      memory: "id, *tags, createdAt, pinned",
      artifacts: "id, type, workspaceId, updatedAt",
      runs: "id, agentId, chainId, createdAt",
    });
  }
}

export const db = new WorkbenchDB();

// Після будь-якої зміни пам'яті, артефактів чи профілю повідомляємо підписникам (коли транзакція завершилась).
const touch = () => {
  const tx = Dexie.currentTransaction;
  if (tx) tx.on("complete", bumpDataVersion);
  else bumpDataVersion();
};
for (const table of [db.memory, db.artifacts, db.profile] as Table<any, any>[]) {
  table.hook("creating", () => {
    touch();
  });
  table.hook("updating", () => {
    touch();
    return undefined;
  });
  table.hook("deleting", () => {
    touch();
  });
}

const firstLine = (s: string): string =>
  (s.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();

/** Зберігає текст як новий артефакт (версія 1). Заголовок береться з першого рядка. */
export async function saveTextArtifact(content: string, type: Artifact["type"], opts: { parentRunId?: string; fallbackTitle?: string } = {}): Promise<Artifact> {
  const now = Date.now();
  const artifact: Artifact = {
    id: crypto.randomUUID(),
    type,
    title: (firstLine(content) || opts.fallbackTitle || "Без назви").slice(0, 80),
    content,
    summary: content.replace(/\s+/g, " ").trim().slice(0, 200),
    parentRunId: opts.parentRunId,
    versions: [{ at: now, content }],
    updatedAt: now,
  };
  await db.artifacts.add(artifact);
  return artifact;
}

export const saveRunAsArtifact = (run: Run, type: Artifact["type"] = "document"): Promise<Artifact> =>
  saveTextArtifact(run.output, type, { parentRunId: run.id, fallbackTitle: run.input });

// ----- Профіль -----

export const emptyProfile = (): Profile => ({
  id: "me",
  name: "",
  language: "uk",
  tone: "",
  audience: "",
  expertise: [],
  brandWords: [],
  codingPrefs: { stack: [], style: "" },
  privateFields: [],
});

export async function getProfile(): Promise<Profile> {
  return { ...emptyProfile(), ...((await db.profile.get("me")) ?? {}) };
}

export async function saveProfile(p: Profile): Promise<void> {
  await db.profile.put({ ...p, id: "me" });
}

// ----- Пам'ять -----

export interface FactInput {
  text: string;
  tags: string[];
  pinned: boolean;
  source: MemoryItem["source"];
}

export const parseTags = (raw: string): string[] =>
  [...new Set(raw.split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean))];

export async function addMemory(f: FactInput): Promise<MemoryItem> {
  const text = f.text.trim();
  if (!text) throw new Error("Порожній факт");
  const item: MemoryItem = {
    id: crypto.randomUUID(),
    text,
    tags: f.tags,
    source: f.source,
    createdAt: Date.now(),
    pinned: f.pinned ? 1 : 0,
  };
  await db.memory.add(item);
  return item;
}

export async function updateMemory(id: string, patch: Partial<Pick<MemoryItem, "text" | "tags" | "pinned">>): Promise<void> {
  await db.memory.update(id, patch);
}

export async function exportAll(): Promise<Record<string, unknown>> {
  const [profile, memory, artifacts, runs] = await Promise.all([
    db.profile.toArray(),
    db.memory.toArray(),
    db.artifacts.toArray(),
    db.runs.toArray(),
  ]);
  return { app: "ai-workbench", schema: 1, exportedAt: new Date().toISOString(), profile, memory, artifacts, runs };
}
