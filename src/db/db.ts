import Dexie, { type Table } from "dexie";
import type { Artifact, MemoryItem, Profile, Run } from "../core/types";

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

const firstLine = (s: string): string =>
  (s.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();

export async function saveRunAsArtifact(run: Run, type: Artifact["type"] = "document"): Promise<Artifact> {
  const content = run.output;
  const now = Date.now();
  const artifact: Artifact = {
    id: crypto.randomUUID(),
    type,
    title: (firstLine(content) || run.input).slice(0, 80),
    content,
    summary: content.replace(/\s+/g, " ").trim().slice(0, 200),
    parentRunId: run.id,
    versions: [{ at: now, content }],
    updatedAt: now,
  };
  await db.artifacts.add(artifact);
  return artifact;
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
