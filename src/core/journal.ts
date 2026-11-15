import type { Run } from "./types";

export interface JournalChain {
  kind: "chain";
  id: string;
  /** Запуски кроків від першого до останнього. */
  runs: Run[];
  title: string;
  costUsd: number;
  /** Початок ланцюга. */
  at: number;
  /** Скільки кроків заплановано (відомо лише для запусків, записаних після T4.2b). */
  total?: number;
}
export interface JournalRun {
  kind: "run";
  run: Run;
}
export type JournalEntry = JournalChain | JournalRun;

/** Заголовок ланцюга: «Рецепт · тема». Для старих записів без підпису: «Ланцюг · Пошук → Пости → Перевірка». */
export function chainTitle(runs: Run[], nameOf: (agentId: string) => string): string {
  const c = runs.find((r) => r.chain)?.chain;
  return c ? `${c.recipe} · ${c.topic}` : `Ланцюг · ${runs.map((r) => nameOf(r.agentId)).join(" → ")}`;
}

/**
 * Групує запуски одного ланцюга (`chainId`) в одну позицію журналу. Позиція стоїть там, де найновіший запуск ланцюга;
 * запуски поза ланцюгами лишаються окремими. Вхід: від новішого до старішого.
 */
export function groupRuns(runsNewestFirst: Run[], nameOf: (agentId: string) => string): JournalEntry[] {
  const out: JournalEntry[] = [];
  const byChain = new Map<string, JournalChain>();
  for (const r of runsNewestFirst) {
    if (!r.chainId) {
      out.push({ kind: "run", run: r });
      continue;
    }
    let g = byChain.get(r.chainId);
    if (!g) {
      g = { kind: "chain", id: r.chainId, runs: [], title: "", costUsd: 0, at: r.createdAt };
      byChain.set(r.chainId, g);
      out.push(g);
    }
    g.runs.push(r);
  }
  for (const g of byChain.values()) {
    g.runs.sort((a, b) => (a.chain && b.chain ? a.chain.index - b.chain.index : a.createdAt - b.createdAt));
    g.costUsd = g.runs.reduce((s, r) => s + r.usage.costUsd, 0);
    g.title = chainTitle(g.runs, nameOf);
    g.at = g.runs[0].createdAt;
    g.total = g.runs.find((r) => r.chain)?.chain?.total;
  }
  return out;
}

/**
 * Підпис запуску всередині ланцюга: «Крок 2 з 3 · Пости». Крок доопрацювання, що стоїть за межами плану,
 * підписується без «з N»: «Крок 4 · Пости (виправлення)».
 */
export function stepLabel(r: Run, position: number, nameOf: (agentId: string) => string): string {
  const c = r.chain;
  const n = c ? c.index + 1 : position + 1;
  const of = c && c.index < c.total ? ` з ${c.total}` : "";
  return `Крок ${n}${of} · ${nameOf(r.agentId)}${c?.label ? ` (${c.label})` : ""}`;
}
