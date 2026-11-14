import type { AgentManifest } from "./types";
import { estimateTokens, type Resolved } from "./contextBuilder";
import { costFor, inputCostFor } from "./prices";
import { MODEL_MAP } from "./settings";

/** Оцінка вхідних токенів і вартості запуску (без вихідних токенів і без урахування кешу). */
export function estimateRun(agent: AgentManifest, resolved: Resolved, taskText: string): { tokens: number; costUsd: number } {
  const tokens = resolved.packet.tokenEstimate + estimateTokens(agent.systemPrompt) + estimateTokens(taskText);
  return { tokens, costUsd: inputCostFor(MODEL_MAP[agent.model], tokens) };
}

/**
 * Найгірший випадок вартості одного запуску для перевірки ліміту ланцюга: вхідні токени + повний `max_tokens` на виході
 * + усі дозволені веб-пошуки. Це оцінка одного виклику моделі: токени результатів пошуку й додаткові кроки циклу не враховано,
 * авторитетний облік (і справжні ліміти) лишаються на проксі.
 */
export function worstCaseRunUsd(agent: AgentManifest, resolved: Resolved, taskText: string): number {
  const { tokens } = estimateRun(agent, resolved, taskText);
  const searches = (agent.serverTools ?? []).reduce((n, t) => n + (typeof t.max_uses === "number" ? t.max_uses : 0), 0);
  return costFor(MODEL_MAP[agent.model], { input_tokens: tokens, output_tokens: agent.maxTokens, server_tool_use: { web_search_requests: searches } });
}
