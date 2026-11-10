import type { ToolDef } from "../core/types";

export interface EditPreview {
  index: number;
  kind: "replace" | "insert";
  /** Що замінюється (або після чого вставляється). */
  before: string;
  after: string;
  reason?: string;
  ok: boolean;
  error?: string;
}

export interface ConfirmRequest {
  title: string;
  subtitle?: string;
  edits: EditPreview[];
}

export interface ConfirmDecision {
  approve: boolean;
  /** Індекси правок, які користувач прийняв. Без поля діє «усі коректні». */
  accepted?: number[];
}

export interface AskRequest {
  question: string;
  options?: string[];
}

export interface ToolContext {
  signal?: AbortSignal;
  /** Скільки разів у цьому запуску вже викликано кожен інструмент (включно з поточним викликом). */
  calls?: Record<string, number>;
  /** Агент і джерело даних, з якими працює запуск (для propose_memory). */
  agentId?: string;
  origin?: "user" | "web";
  ui: {
    confirm?: (r: ConfirmRequest) => Promise<ConfirmDecision>;
    ask?: (r: AskRequest) => Promise<string>;
  };
}

export interface ToolPlan {
  /** Помилка до виконання: повертається моделі як tool_result з is_error. */
  error?: string;
  /** Якщо задано, перед виконанням потрібне підтвердження користувача (diff). */
  confirm?: ConfirmRequest;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolHandler {
  def: ToolDef;
  /** Успішний виклик завершує запуск: його результат стає виходом агента. */
  terminal?: boolean;
  plan?(input: unknown, ctx: ToolContext): Promise<ToolPlan>;
  run(input: unknown, ctx: ToolContext, decision?: ConfirmDecision): Promise<ToolResult>;
}
