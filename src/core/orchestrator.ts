import { AGENTS } from "../agents/registry";
import { ApiError } from "./claude";
import type { Source } from "./citations";
import { resolveContext } from "./contextBuilder";
import { worstCaseRunUsd } from "./estimate";
import { runAgent, type RunUi } from "./runner";
import type { AgentManifest, Run, Task } from "./types";

/** Запобіжники ланцюга (етап 4): без них агенти можуть безкінечно «покращувати» текст і витрачати бюджет. */
export const MAX_CHAIN_STEPS = 6;
export const DEFAULT_CHAIN_LIMIT_USD = 0.25;

export interface StepResult {
  index: number;
  agentId: string;
  instruction: string;
  run: Run;
  text: string;
  sources: Source[];
}

export interface ChainStep {
  agentId: string;
  instruction: string;
  /** Точка зупинки: після цього кроку показати результат і чекати підтвердження користувача. */
  pauseAfter?: boolean;
  /** Як зібрати `upstream` цього кроку з попередніх результатів. За замовчуванням це вихід попереднього кроку. */
  upstreamFrom?: (done: StepResult[]) => string;
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
  onStepStart?: (index: number, step: ChainStep, agent: AgentManifest) => void;
  onStepDone?: (index: number, result: StepResult) => void;
  /** Наступний крок може перевищити ліміт вартості: true = продовжити. Без обробника ланцюг зупиняється. */
  confirmCost?: (gate: CostGate) => Promise<boolean>;
  /** Точка зупинки після кроку: true = продовжити. Без обробника ланцюг зупиняється. */
  confirmContinue?: (info: { stepIndex: number; result: StepResult; next: ChainStep }) => Promise<boolean>;
}

export interface ChainOptions {
  limitUsd?: number;
}

export type ChainStatus = "done" | "stopped_cost" | "stopped_user" | "aborted";

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
  const agents = steps.map((s) => {
    const a = AGENTS.find((x) => x.id === s.agentId);
    if (!a) throw new Error(`Невідомий агент у ланцюгу: ${s.agentId}`);
    return a;
  });

  const chainId = crypto.randomUUID();
  const done: StepResult[] = [];
  let spent = 0;
  const finish = (status: ChainStatus): ChainResult => ({ chainId, status, steps: done, output: done.at(-1)?.text ?? "", costUsd: spent });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const agent = agents[i];
    if (ui.signal?.aborted) return finish("aborted");

    const task: Task = { input: step.instruction, chainId };
    if (i > 0) {
      const upstream = step.upstreamFrom ? step.upstreamFrom(done) : done[i - 1].text;
      if (!upstream.trim()) throw new Error(`Крок «${agents[i - 1].name}» не дав результату, ланцюг зупинено.`);
      task.upstream = upstream;
      // Якщо будь-який попередній крок читав інтернет, усе далі походить від недовіреного вмісту (інваріант 17).
      if (agents.slice(0, i).some(readsWeb)) task.upstreamOrigin = "web";
    }

    // Вартість перевіряється до запиту: найгірший випадок кроку плюс уже витрачене.
    const estimate = worstCaseRunUsd(agent, await resolveContext(agent, task), task.input);
    if (spent + estimate > limit) {
      const proceed = ui.confirmCost ? await ui.confirmCost({ stepIndex: i, agentId: agent.id, spent, estimate, limit }) : false;
      if (!proceed) return finish("stopped_cost");
    }

    ui.onStepStart?.(i, step, agent);
    let res;
    try {
      res = await runAgent(agent, task, ui);
    } catch (e) {
      if (e instanceof ApiError && e.kind === "aborted") return finish("aborted");
      throw e;
    }
    spent += res.run.usage.costUsd;
    const result: StepResult = { index: i, agentId: agent.id, instruction: step.instruction, run: res.run, text: res.text, sources: res.sources };
    done.push(result);
    ui.onStepDone?.(i, result);

    if (step.pauseAfter && i < steps.length - 1) {
      const proceed = ui.confirmContinue ? await ui.confirmContinue({ stepIndex: i, result, next: steps[i + 1] }) : false;
      if (!proceed) return finish("stopped_user");
    }
  }
  return finish("done");
}
