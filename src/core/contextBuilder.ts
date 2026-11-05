import type { AgentManifest, ContextPacket, ContextSource, Task } from "./types";

/** Груба оцінка для української: ≈3,5 символа на токен. Точний підрахунок — через count_tokens (пізніше). */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.5);

/** Обгортає дані в XML-тег; закриваючі теги всередині тексту нейтралізуються. */
export function xml(tag: string, text: string): string {
  const safe = text.split(`</${tag}`).join(`<\\/${tag}`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

/**
 * Етап 1: підтримуються лише `selection` і `upstream`.
 * Профіль, пам'ять, артефакти й історія з'являться на етапі 2 (бюджет токенів, пошук, панель контексту).
 */
export async function buildContext(agent: AgentManifest, task: Task): Promise<ContextPacket> {
  const operative: string[] = [];
  const sources: ContextSource[] = [];
  for (const need of agent.contextNeeds) {
    if (need.source === "selection" && task.selection) {
      operative.push(xml("selection", task.selection));
      sources.push({ kind: "selection", id: "selection", title: "Виділений текст" });
    } else if (need.source === "upstream" && task.upstream) {
      operative.push(xml("upstream", task.upstream));
      sources.push({ kind: "upstream", id: "upstream", title: "Вихід попереднього кроку" });
    }
  }
  const text = operative.join("\n");
  return { stable: "", relevant: "", operative: text, tokenEstimate: estimateTokens(text), sources };
}
