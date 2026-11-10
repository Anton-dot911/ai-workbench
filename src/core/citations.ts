import type { ContentBlock } from "./claude";

export interface Source {
  url: string;
  title: string;
}

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Збирає фінальний текст відповіді з блоків усіх кроків і додає маркери цитат [1], [2, 3].
 * Нумерація джерел наскрізна, за порядком першої згадки; однакові URL об'єднуються.
 */
export function renderCitations(steps: ContentBlock[][]): { text: string; sources: Source[] } {
  const sources: Source[] = [];
  const index = new Map<string, number>();
  let text = "";
  steps.forEach((blocks, stepNo) => {
    const parts = blocks.filter((b) => b.type === "text" && (b.text ?? "").length > 0);
    if (stepNo > 0 && text && parts.length) text += "\n\n";
    for (const b of parts) {
      text += b.text ?? "";
      const ids = new Set<number>();
      for (const c of (Array.isArray(b.citations) ? b.citations : []) as { type?: string; url?: string; title?: string }[]) {
        if (c?.type !== "web_search_result_location" || !c.url) continue;
        let i = index.get(c.url);
        if (i === undefined) {
          i = sources.length;
          sources.push({ url: c.url, title: c.title?.trim() || host(c.url) });
          index.set(c.url, i);
        }
        ids.add(i + 1);
      }
      if (ids.size) text += ` [${[...ids].sort((a, b) => a - b).join(", ")}]`;
    }
  });
  return { text, sources };
}

export const sourceHost = host;
