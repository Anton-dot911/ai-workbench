import type { AgentManifest } from "./types";
import { estimateTokens, type Resolved } from "./contextBuilder";
import { inputCostFor } from "./prices";
import { MODEL_MAP } from "./settings";

/** Оцінка вхідних токенів і вартості запуску (без вихідних токенів і без урахування кешу). */
export function estimateRun(agent: AgentManifest, resolved: Resolved, taskText: string): { tokens: number; costUsd: number } {
  const tokens = resolved.packet.tokenEstimate + estimateTokens(agent.systemPrompt) + estimateTokens(taskText);
  return { tokens, costUsd: inputCostFor(MODEL_MAP[agent.model], tokens) };
}
