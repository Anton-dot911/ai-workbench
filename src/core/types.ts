import type { Usage } from "../../shared/pricing";

export type ModelTier = "fast" | "balanced" | "deep";
export type ArtifactType = "document" | "post" | "code" | "search_report" | "review" | "note";
export type JSONSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

export type ContextNeed =
  | { source: "profile"; fields?: string[] }
  | { source: "memory"; query: "auto" | string; topK: number }
  | { source: "artifacts"; types: ArtifactType[]; topK: number }
  | { source: "selection" }
  | { source: "history"; lastN: number }
  | { source: "upstream" };

/** Маніфест агента: ядро застосунку не змінюється, коли додається новий агент. */
export interface AgentManifest {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  model: ModelTier;
  systemPrompt: string;
  contextNeeds: ContextNeed[];
  tools: ToolDef[];
  serverTools?: string[];
  output: { kind: "text" | "markdown" | "code" | "json" | "document"; schema?: JSONSchema; saveAs?: ArtifactType };
  maxTokens: number;
  temperature?: number;
  examples: string[];
}

export type Tier = "stable" | "relevant" | "operative";

export interface Task {
  input: string;
  selection?: string;
  upstream?: string;
  sessionId?: string;
  chainId?: string;
  mode?: string;
  /** Останні обміни цієї сесії (джерело `history`). */
  history?: { task: string; output: string }[];
  /** Ручні перемикачі джерел контексту: id джерела → увімкнено. Без запису діє `defaultOn`. */
  toggles?: Record<string, boolean>;
  /** Артефакти, додані до контексту вручну. */
  extraArtifactIds?: string[];
}

export interface ContextSource {
  kind: string;
  id: string;
  title: string;
  /** Поля нижче відсутні в запусках, збережених на етапі 1. */
  tier?: Tier;
  tokens?: number;
}

export interface ContextPacket {
  stable: string;
  relevant: string;
  operative: string;
  tokenEstimate: number;
  sources: ContextSource[];
  warnings?: string[];
}

// ----- Сховище (IndexedDB через Dexie) -----

export interface Profile {
  id: "me";
  name: string;
  language: string;
  tone: string;
  audience: string;
  expertise: string[];
  brandWords?: string[];
  codingPrefs?: { stack: string[]; style: string };
  /** Поля, які збирач контексту не передає в запити, поки агент не попросить явно. */
  privateFields?: string[];
}

export interface MemoryItem {
  id: string;
  text: string;
  tags: string[];
  embedding?: number[];
  source: "user" | "agent";
  createdAt: number;
  /** 0/1, а не boolean: IndexedDB не індексує boolean. */
  pinned?: 0 | 1;
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  content: string;
  summary: string;
  embedding?: number[];
  workspaceId?: string;
  parentRunId?: string;
  versions: { at: number; content: string }[];
  updatedAt: number;
}

export interface Run {
  id: string;
  agentId: string;
  input: string;
  contextSnapshot: ContextPacket;
  output: string;
  usage: { input: number; output: number; cacheRead: number; costUsd: number };
  chainId?: string;
  createdAt: number;
}

export type { Usage };
