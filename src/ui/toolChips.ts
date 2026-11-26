import type { ToolEvent } from "../core/runner";

export interface ToolChip {
  name: string;
  status: ToolEvent["status"];
  detail?: string;
}

/**
 * Мітки інструментів на картці агента. Початок додає мітку; завершення оновлює НАЙСТАРІШУ мітку з тією ж назвою, що
 * ще чекає: паралельні веб-пошуки завершуються в порядку запуску, а між початком і кінцем одного пошуку можуть
 * з'явитись інші інструменти чи пошуки (раніше оновлювалась лише остання мітка, і решта лишалась «…»).
 */
export function applyToolEvent(tools: ToolChip[], e: ToolEvent): ToolChip[] {
  if (e.status === "start") return [...tools, { name: e.name, status: "start", ...(e.detail ? { detail: e.detail } : {}) }];
  const k = tools.findIndex((t) => t.name === e.name && t.status === "start");
  if (k < 0) return tools;
  return tools.map((t, n) => (n === k ? { ...t, status: e.status, ...(e.detail ? { detail: e.detail } : {}) } : t));
}

/** Завершений запуск не лишає міток «…»: ті, що ще чекають, позначаються виконаними. */
export const settleTools = (tools: ToolChip[]): ToolChip[] => tools.map((t) => (t.status === "start" ? { ...t, status: "ok" as const } : t));
