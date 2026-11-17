import { AGENTS } from "../agents/registry";
import { ApiError } from "./claude";
import type { Source } from "./citations";
import { resolveContext } from "./contextBuilder";
import { worstCaseRunUsd } from "./estimate";
import { CHAIN_LIMIT_DEFAULT_USD } from "./settings";
import { runAgent, type RunUi } from "./runner";
import type { AgentManifest, Run, Task } from "./types";

/** Запобіжники ланцюга (етап 4): без них агенти можуть безкінечно «покращувати» текст і витрачати бюджет. */
export const MAX_CHAIN_STEPS = 6;
export const DEFAULT_CHAIN_LIMIT_USD = CHAIN_LIMIT_DEFAULT_USD;
/** Скільки разів крок може повернути ланцюг на доопрацювання (цикл «перевірка → виправлення»). */
export const MAX_RETRIES = 2;

/** `plan`: крок із плану; `fix`: виправлення після невдалої перевірки; `redo`: повтор перевіряльного кроку після виправлення. */
export type StepKind = "plan" | "fix" | "redo";
const KIND_LABEL: Partial<Record<StepKind, string>> = { fix: "виправлення", redo: "повтор" };

export interface StepResult {
  index: number;
  agentId: string;
  instruction: string;
  run: Run;
  text: string;
  sources: Source[];
  stopReason: string | null;
  kind: StepKind;
}

export interface ChainStep {
  agentId: string;
  instruction: string;
  /** Точка зупинки: після цього кроку показати результат і чекати підтвердження користувача. */
  pauseAfter?: boolean;
  /** Як зібрати `upstream` цього кроку з попередніх результатів. За замовчуванням це вихід попереднього кроку. */
  upstreamFrom?: (done: StepResult[]) => string;
  /**
   * Цикл доопрацювання: якщо `needed(результат)`, запускається крок `fix`, а потім цей крок повторюється (до `max` разів).
   * Кроки виправлення й повтору рахуються в ліміт кроків і вартості ланцюга, як звичайні.
   */
  retry?: RetrySpec;
}

export interface RetrySpec {
  /** Чи потрібне доопрацювання за результатом цього кроку (наприклад, вердикт `needs_changes`). */
  needed: (result: StepResult) => boolean;
  /** Крок виправлення. За замовчуванням його `upstream` це вихід кроку, що викликав доопрацювання. */
  fix: { agentId: string; instruction: string; upstreamFrom?: (done: StepResult[], trigger: StepResult) => string };
  max: number;
}

export interface StepMeta {
  kind: StepKind;
  label?: string;
}

export interface CostGate {
  stepIndex: number;
  agentId: string;
  /** Уже витрачено в цьому ланцюгу (з `usage` виконаних кроків). */
  spent: number;
  /** Найгірший випадок вартості наступного кроку. */
  estimate: number;
  limit: number;
}

export interface ChainUi extends RunUi {
  onStepStart?: (index: number, step: ChainStep, agent: AgentManifest, meta: StepMeta) => void;
  onStepDone?: (index: number, result: StepResult) => void;
  /** Наступний крок може перевищити ліміт вартості: true = продовжити. Без обробника ланцюг зупиняється. */
  confirmCost?: (gate: CostGate) => Promise<boolean>;
  /** Точка зупинки після кроку: true = продовжити. Без обробника ланцюг зупиняється. */
  confirmContinue?: (info: { stepIndex: number; result: StepResult; next: ChainStep }) => Promise<boolean>;
}

export interface ChainOptions {
  limitUsd?: number;
  /** Підпис ланцюга для журналу: рецепт і тема. Кожен запуск зберігає його разом із номером кроку. */
  label?: { recipe: string; topic: string };
  /** Фрагмент користувача: отримує лише перший крок (наприклад, «Перевірка» вставленого тексту). */
  selection?: string;
}

/** `stopped_steps`: доопрацювання не вмістилось у ліміт кроків ланцюга. */
export type ChainStatus = "done" | "stopped_cost" | "stopped_user" | "aborted" | "stopped_steps";

export interface ChainResult {
  chainId: string;
  status: ChainStatus;
  steps: StepResult[];
  /** Вихід останнього виконаного кроку. */
  output: string;
  /** Фактична вартість виконаних кроків (за `usage`). */
  costUsd: number;
}

const readsWeb = (a: AgentManifest): boolean => !!a.serverTools?.length;

/**
 * Виконує кроки послідовно: вихід кроку стає `upstream` наступного, а кожен агент збирає власний контекст.
 * Усі запуски ланцюга мають спільний `chainId` у журналі.
 * Дії зі змінами даних усередині кроків, як і раніше, проходять через підтвердження (diff) в інструментах.
 */
export async function runChain(steps: ChainStep[], ui: ChainUi, opts: ChainOptions = {}): Promise<ChainResult> {
  if (!steps.length) throw new Error("Ланцюг порожній.");
  if (steps.length > MAX_CHAIN_STEPS) throw new Error(`Ланцюг довший за ліміт: ${steps.length} кроків із ${MAX_CHAIN_STEPS}.`);
  const limit = opts.limitUsd ?? DEFAULT_CHAIN_LIMIT_USD;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("Ліміт вартості ланцюга має бути додатним числом.");
  // Невідомий агент не замінюється запасним (на відміну від getAgent): помилка до першого запиту.
  const agentOf = (id: string): AgentManifest => {
    const a = AGENTS.find((x) => x.id === id);
    if (!a) throw new Error(`Невідомий агент у ланцюгу: ${id}`);
    return a;
  };
  for (const st of steps) {
    agentOf(st.agentId);
    if (st.retry) {
      agentOf(st.retry.fix.agentId);
      if (!Number.isInteger(st.retry.max) || st.retry.max < 1 || st.retry.max > MAX_RETRIES) throw new Error(`Кількість повторів має бути від 1 до ${MAX_RETRIES}.`);
    }
  }

  interface Queued {
    step: ChainStep;
    agent: AgentManifest;
    kind: StepKind;
  }
  const queue: Queued[] = steps.map((step) => ({ step, agent: agentOf(step.agentId), kind: "plan" as const }));
  const retries = new Map<ChainStep, number>();
  const chainId = crypto.randomUUID();
  const done: StepResult[] = [];
  let spent = 0;
  const finish = (status: ChainStatus): ChainResult => ({ chainId, status, steps: done, output: done.at(-1)?.text ?? "", costUsd: spent });

  while (queue.length) {
    if (ui.signal?.aborted) return finish("aborted");
    // Запобіжник від нескінченного «покращування»: ліміт стосується всіх виконаних кроків, разом із виправленнями.
    if (done.length >= MAX_CHAIN_STEPS) return finish("stopped_steps");
    const { step, agent, kind } = queue.shift()!;
    const i = done.length;
    const label = KIND_LABEL[kind];

    const task: Task = { input: step.instruction, chainId };
    if (i === 0 && opts.selection) task.selection = opts.selection;
    if (opts.label) task.chain = { ...opts.label, index: i, total: steps.length, ...(label ? { label } : {}) };
    if (i > 0) {
      const upstream = step.upstreamFrom ? step.upstreamFrom(done) : done[i - 1].text;
      if (!upstream.trim()) throw new Error(`Крок «${agentOf(done[i - 1].agentId).name}» не дав результату, ланцюг зупинено.`);
      task.upstream = upstream;
      // Якщо будь-який попередній крок читав інтернет, усе далі походить від недовіреного вмісту (інваріант 17).
      if (done.some((d) => readsWeb(agentOf(d.agentId)))) task.upstreamOrigin = "web";
    }

    // Вартість перевіряється до запиту: найгірший випадок кроку плюс уже витрачене.
    const estimate = worstCaseRunUsd(agent, await resolveContext(agent, task), task.input);
    if (spent + estimate > limit) {
      const proceed = ui.confirmCost ? await ui.confirmCost({ stepIndex: i, agentId: agent.id, spent, estimate, limit }) : false;
      if (!proceed) return finish("stopped_cost");
    }

    ui.onStepStart?.(i, step, agent, { kind, ...(label ? { label } : {}) });
    let res;
    try {
      res = await runAgent(agent, task, ui);
    } catch (e) {
      if (e instanceof ApiError && e.kind === "aborted") return finish("aborted");
      throw e;
    }
    spent += res.run.usage.costUsd;
    const result: StepResult = { index: i, agentId: agent.id, instruction: step.instruction, run: res.run, text: res.text, sources: res.sources, stopReason: res.stopReason, kind };
    done.push(result);
    ui.onStepDone?.(i, result);

    // Доопрацювання: виправлення, потім повтор цього кроку. Виправлення саме не повертає ланцюг на доопрацювання.
    if (step.retry && kind !== "fix" && (retries.get(step) ?? 0) < step.retry.max && step.retry.needed(result)) {
      if (done.length + 2 + queue.length > MAX_CHAIN_STEPS) return finish("stopped_steps");
      retries.set(step, (retries.get(step) ?? 0) + 1);
      const fix = step.retry.fix;
      const fixStep: ChainStep = { agentId: fix.agentId, instruction: fix.instruction, upstreamFrom: (d) => (fix.upstreamFrom ? fix.upstreamFrom(d, result) : result.text) };
      queue.unshift({ step: fixStep, agent: agentOf(fix.agentId), kind: "fix" }, { step, agent, kind: "redo" });
    }

    if (step.pauseAfter && kind === "plan" && queue.length) {
      const proceed = ui.confirmContinue ? await ui.confirmContinue({ stepIndex: i, result, next: queue[0].step }) : false;
      if (!proceed) return finish("stopped_user");
    }
  }
  return finish("done");
}
