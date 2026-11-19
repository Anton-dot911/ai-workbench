import type { Usage } from "../../shared/pricing";

export type ModelTier = "fast" | "balanced" | "deep";
export type ArtifactType = "document" | "post" | "code" | "search_report" | "review" | "note" | "engineering_package";
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
  /** Ім'я іконки з ui/Icon. */
  icon: string;
  /** Slash-команди, що вибирають цього агента: `/док`, `/пост`. */
  commands: string[];
  description: string;
  model: ModelTier;
  systemPrompt: string;
  contextNeeds: ContextNeed[];
  tools: ToolDef[];
  /** Серверні інструменти Anthropic (повні визначення): виконуються на боці API, напр. web_search. */
  serverTools?: Record<string, unknown>[];
  /** Завершальний інструмент: агент має його викликати; runner перевіряє виклик і повторює запит, якщо модель завершила звичайним текстом. Його вхід і є результат агента. */
  finalTool?: string;
  output: { kind: "text" | "markdown" | "code" | "json" | "document"; schema?: JSONSchema; saveAs?: ArtifactType };
  maxTokens: number;
  examples: string[];
  /** Кому цей агент може передавати завдання інструментом `handoff` (лише так, і лише з підтвердженням). */
  handoffTo?: string[];
  /** Ліміт кроків циклу tool use для цього агента (за замовчуванням `MAX_STEPS`, не більше `MAX_STEPS_HARD`). */
  maxSteps?: number;
}

export type Tier = "stable" | "relevant" | "operative";

export interface Task {
  input: string;
  selection?: string;
  upstream?: string;
  /** `web`: upstream походить із кроку, що читав інтернет (прямо чи через ланцюг): передається як <untrusted_content>. */
  upstreamOrigin?: "web";
  sessionId?: string;
  chainId?: string;
  chain?: ChainInfo;
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
  /** Джерела (для звітів пошуку). */
  sources?: { url: string; title: string }[];
  versions: { at: number; content: string }[];
  updatedAt: number;
}

/** Належність запуску до ланцюга: рецепт, тема й місце кроку. Журнал групує запуски за `chainId` і підписує їх цими даними. */
export interface ChainInfo {
  recipe: string;
  topic: string;
  index: number;
  total: number;
  /** Доопрацювання: `виправлення` чи `повтор`. Такі кроки можуть стояти за межами плану (index ≥ total). */
  label?: string;
}

/** Вкладений запуск, який агент ініціював інструментом `handoff` (підтверджений користувачем). Вартість входить у `usage` батьківського запуску. */
export interface HandoffRecord {
  agentId: string;
  instruction: string;
  output: string;
  usage: { input: number; output: number; cacheRead: number; costUsd: number; searches?: number };
  sources?: { url: string; title: string }[];
  depth: number;
}

export interface Run {
  id: string;
  agentId: string;
  input: string;
  contextSnapshot: ContextPacket;
  output: string;
  usage: { input: number; output: number; cacheRead: number; costUsd: number; searches?: number };
  chainId?: string;
  chain?: ChainInfo;
  createdAt: number;
  /** Джерела, на які агент послався (веб-пошук). */
  sources?: { url: string; title: string }[];
  /** Кількість викликів моделі в циклі tool use. */
  steps?: number;
  toolCalls?: { name: string; ok: boolean }[];
  /** Передачі завдань іншим агентам під час цього запуску. */
  handoffs?: HandoffRecord[];
}

/** Пропозиція факту від агента: потрапляє в чергу, а в пам'ять лише після підтвердження користувача. */
export interface Proposal {
  id: string;
  text: string;
  tags: string[];
  pinned?: boolean;
  /** `web`: агент читав інтернет, тож пропозицію варто перевірити особливо уважно. */
  origin: "user" | "web";
  agentId: string;
  reason?: string;
  status: "pending" | "rejected";
  createdAt: number;
}

export type { Usage };
