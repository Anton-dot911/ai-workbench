import type { AgentManifest } from "../core/types";
import { docsAgent } from "./docs";
import { postsAgent } from "./posts";
import { reviewAgent } from "./review";

/** Реєстр агентів. Новий агент = новий маніфест у цьому списку, ядро не змінюється. */
export const AGENTS: AgentManifest[] = [docsAgent, reviewAgent, postsAgent];

export const getAgent = (id: string): AgentManifest => AGENTS.find((a) => a.id === id) ?? AGENTS[0];

/** Розбирає slash-команду на початку задачі: «/док скороти» → агент «Документи» і решта тексту. */
export function parseCommand(input: string): { agent: AgentManifest; rest: string } | null {
  const m = input.trim().match(/^(\/\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const agent = AGENTS.find((a) => a.commands.includes(cmd));
  return agent ? { agent, rest: m[2].trim() } : null;
}
