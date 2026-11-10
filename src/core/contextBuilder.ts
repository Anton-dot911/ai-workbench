import { db, getProfile } from "../db/db";
import { retrieve } from "./retrieval";
import { CONTEXT_BUDGET } from "./settings";
import type { AgentManifest, ContextPacket, Profile, Task, Tier } from "./types";

/** Груба оцінка для української: ≈3,5 символа на токен. Точний підрахунок — через count_tokens (пізніше). */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.5);

// Закриваючі теги наших обгорток у даних нейтралізуються, щоб дані не «вийшли» з тега.
const CLOSERS = /<\/(profile|facts|memory|examples|documents|selection|upstream|history|context|task|untrusted_content)/gi;
export const neutralize = (s: string): string => s.replace(CLOSERS, "<\\/$1");

/** Звіти веб-пошуку містять переказ зовнішніх сторінок: передаються моделі як недовірені дані. */
export const untrusted = (kind: string, text: string): string =>
  kind === "search_report" ? `<untrusted_content source="web-search-report">\n${text}\n</untrusted_content>` : text;

export function xml(tag: string, text: string): string {
  return `<${tag}>\n${neutralize(text)}\n</${tag}>`;
}

/** Залишає початок і кінець тексту, середину вирізає. */
export function truncateSmart(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, Math.floor(maxTokens * 3.5));
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head);
  return `${text.slice(0, head)}\n[…скорочено…]\n${tail ? text.slice(text.length - tail) : ""}`;
}

/** Одне джерело контексту (рядок на панелі контексту). */
export interface Part {
  id: string;
  tier: Tier;
  priority: number;
  kind: string;
  title: string;
  detail: string;
  open: string;
  close: string;
  /** Елементи скорочуються окремо: спершу відкидаються найменш важливі. */
  items: string[];
  dropFrom?: "start" | "end";
  /** Не скорочується бюджетом (профіль, виділення, вихід попереднього кроку). */
  fixed?: boolean;
  defaultOn: boolean;
  manual?: boolean;
}

export interface ResolvedPart extends Part {
  on: boolean;
  keptItems: string[];
  text: string;
  tokens: number;
  fullTokens: number;
  shrunk: boolean;
  dropped: boolean;
}

export interface Resolved {
  parts: ResolvedPart[];
  packet: ContextPacket;
  budget: number;
}

export const renderPart = (p: Pick<Part, "open" | "close">, items: string[]): string =>
  items.length ? `${p.open}\n${items.join("\n")}\n${p.close}` : "";

const PROFILE_FIELDS = ["language", "tone", "audience", "expertise", "brandWords", "codingPrefs"] as const;
const PROFILE_LABEL: Record<string, string> = {
  language: "мова",
  tone: "тон",
  audience: "аудиторія",
  expertise: "експертиза",
  brandWords: "слова бренду",
  codingPrefs: "код",
};

function profileLines(p: Profile, fields?: string[]): { lines: string[]; used: string[]; hidden: string[] } {
  const wanted = (fields?.length ? fields : [...PROFILE_FIELDS]).filter((f) => (PROFILE_FIELDS as readonly string[]).includes(f));
  const priv = new Set(p.privateFields ?? []);
  const lines: string[] = [];
  const used: string[] = [];
  const hidden: string[] = [];
  for (const f of wanted) {
    let value = "";
    if (f === "language") value = p.language;
    else if (f === "tone") value = p.tone;
    else if (f === "audience") value = p.audience;
    else if (f === "expertise") value = (p.expertise ?? []).join(", ");
    else if (f === "brandWords") value = (p.brandWords ?? []).join(", ");
    else if (f === "codingPrefs") {
      const c = p.codingPrefs;
      value = c && (c.stack.length || c.style) ? [c.stack.length ? `стек: ${c.stack.join(", ")}` : "", c.style ? `стиль: ${c.style}` : ""].filter(Boolean).join("; ") : "";
    }
    if (!value.trim()) continue;
    if (priv.has(f)) {
      hidden.push(PROFILE_LABEL[f]);
      continue;
    }
    lines.push(`${f}: ${value.trim()}`);
    used.push(PROFILE_LABEL[f]);
  }
  return { lines, used, hidden };
}

const queryText = (t: Task): string => `${t.input} ${t.selection?.slice(0, 300) ?? ""}`.trim();

/** Збирає всі кандидати на контекст для агента (разом з тими, що вимкнені за замовчуванням). */
export async function collectParts(agent: AgentManifest, task: Task): Promise<Part[]> {
  const parts: Part[] = [];
  const extraIds = new Set(task.extraArtifactIds ?? []);

  for (const need of agent.contextNeeds) {
    switch (need.source) {
      case "profile": {
        const { lines, used, hidden } = profileLines(await getProfile(), need.fields);
        if (!lines.length) break;
        parts.push({
          id: "profile",
          tier: "stable",
          priority: 100,
          fixed: true,
          kind: "profile",
          title: "Профіль",
          detail: `${used.join(", ")}${hidden.length ? ` · приховано: ${hidden.join(", ")}` : ""}`,
          open: "<profile>",
          close: "</profile>",
          items: lines.map(neutralize),
          defaultOn: true,
        });
        break;
      }
      case "memory": {
        const pinned = await db.memory.where("pinned").equals(1).toArray();
        if (pinned.length) {
          parts.push({
            id: "pinned",
            tier: "stable",
            priority: 90,
            kind: "memory",
            title: `Закріплені факти · ${pinned.length}`,
            detail: "завжди в кешованому префіксі",
            open: "<facts>",
            close: "</facts>",
            items: pinned.map((m) => `- ${neutralize(m.text)}`),
            defaultOn: true,
          });
        }
        const q = need.query === "auto" ? queryText(task) : need.query;
        const hits = await retrieve(q, { kind: "memory", topK: need.topK, exclude: new Set(pinned.map((m) => m.id)) });
        if (hits.length) {
          const rows = (await db.memory.bulkGet(hits.map((h) => h.id))).filter((m): m is NonNullable<typeof m> => !!m);
          parts.push({
            id: "memory",
            tier: "relevant",
            priority: 60,
            kind: "memory",
            title: `Пам'ять · ${rows.length}`,
            detail: "знайдено за темою запиту",
            open: "<memory>",
            close: "</memory>",
            items: rows.map((m) => `- ${neutralize(m.text)}`),
            defaultOn: true,
          });
        }
        break;
      }
      case "artifacts": {
        const hits = await retrieve(queryText(task), { kind: "artifact", types: need.types, topK: need.topK, exclude: extraIds });
        if (!hits.length) break;
        const rows = (await db.artifacts.bulkGet(hits.map((h) => h.id))).filter((a): a is NonNullable<typeof a> => !!a);
        // У контекст іде резюме; повний текст лише для найближчого, якщо він короткий.
        const items = rows.map((a, i) =>
          i === 0 && estimateTokens(a.content) <= 1500
            ? `#${a.id.slice(0, 8)} «${neutralize(a.title)}»:\n${untrusted(a.type, neutralize(a.content))}`
            : `#${a.id.slice(0, 8)} «${neutralize(a.title)}»: ${untrusted(a.type, neutralize(a.summary))}`,
        );
        parts.push({
          id: "artifacts",
          tier: "relevant",
          priority: 50,
          kind: "artifact",
          title: `Споріднені документи · ${rows.length}`,
          detail: "резюме; найближчий повністю, якщо короткий",
          open: "<documents>",
          close: "</documents>",
          items,
          defaultOn: true,
        });
        break;
      }
      case "selection": {
        if (!task.selection) break;
        parts.push({
          id: "selection",
          tier: "operative",
          priority: 95,
          fixed: true,
          kind: "selection",
          title: "Фрагмент",
          detail: "те, що ви вставили",
          open: "<selection>",
          close: "</selection>",
          items: [neutralize(task.selection)],
          defaultOn: true,
        });
        break;
      }
      case "upstream": {
        if (!task.upstream) break;
        parts.push({
          id: "upstream",
          tier: "operative",
          priority: 98,
          fixed: true,
          kind: "upstream",
          title: "Вихід попереднього кроку",
          detail: "передано напряму",
          open: "<upstream>",
          close: "</upstream>",
          items: [neutralize(task.upstream)],
          defaultOn: true,
        });
        break;
      }
      case "history": {
        const turns = (task.history ?? []).slice(-need.lastN);
        if (!turns.length) break;
        parts.push({
          id: "history",
          tier: "operative",
          priority: 40,
          kind: "history",
          title: `Історія сесії · ${turns.length}`,
          detail: "попередні обміни; старі відкидаються першими",
          open: "<history>",
          close: "</history>",
          items: turns.map((t) => `Користувач: ${neutralize(t.task)}\nАгент: ${neutralize(t.output)}`),
          dropFrom: "start",
          defaultOn: false,
        });
        break;
      }
    }
  }

  // Артефакти, додані вручну.
  for (const id of task.extraArtifactIds ?? []) {
    const a = await db.artifacts.get(id);
    if (!a) continue;
    parts.push({
      id: `extra:${id}`,
      tier: "relevant",
      priority: 55,
      kind: "artifact",
      title: a.title,
      detail: "додано вручну",
      open: "<documents>",
      close: "</documents>",
      items: [`#${a.id.slice(0, 8)} «${neutralize(a.title)}»:\n${untrusted(a.type, neutralize(a.content))}`],
      defaultOn: true,
      manual: true,
    });
  }
  return parts;
}

/**
 * Вкладає увімкнені джерела в бюджет токенів. Нескорочувані (профіль, виділення, upstream) беруться завжди;
 * решта за пріоритетом: спершу відкидаються останні елементи, потім середина тексту, потім усе джерело.
 */
export function fitToBudget(
  parts: Part[],
  toggles: Record<string, boolean>,
  budget: number,
): { resolved: ResolvedPart[]; warnings: string[] } {
  const resolved: ResolvedPart[] = parts.map((p) => {
    const text = renderPart(p, p.items);
    const tokens = estimateTokens(text);
    return { ...p, on: toggles[p.id] ?? p.defaultOn, keptItems: p.items, text, tokens, fullTokens: tokens, shrunk: false, dropped: false };
  });
  const warnings: string[] = [];

  let used = resolved.filter((r) => r.on && r.fixed).reduce((s, r) => s + r.tokens, 0);
  if (used > budget) {
    warnings.push(`Обов'язкові джерела (профіль, фрагмент) займають ≈${used} токенів при бюджеті ${budget}. Вони не скорочуються, решта контексту не вміститься.`);
  }

  const optional = resolved.filter((r) => r.on && !r.fixed).sort((a, b) => b.priority - a.priority);
  for (const r of optional) {
    const room = budget - used;
    if (r.fullTokens <= room) {
      used += r.fullTokens;
      continue;
    }
    let items = [...r.items];
    while (items.length > 1 && estimateTokens(renderPart(r, items)) > room) {
      if (r.dropFrom === "start") items.shift();
      else items.pop();
    }
    let text = renderPart(r, items);
    if (estimateTokens(text) > room) {
      const overhead = estimateTokens(`${r.open}\n\n${r.close}`) + 5;
      if (room - overhead > 300 && items.length === 1) {
        items = [truncateSmart(items[0], room - overhead)];
        text = renderPart(r, items);
      } else {
        r.dropped = true;
        r.text = "";
        r.keptItems = [];
        r.tokens = 0;
        warnings.push(`«${r.title}» не вмістилось у бюджет і не буде передано.`);
        continue;
      }
    }
    r.keptItems = items;
    r.text = text;
    r.tokens = estimateTokens(text);
    r.shrunk = true;
    used += r.tokens;
    warnings.push(`«${r.title}» скорочено через бюджет токенів.`);
  }
  return { resolved, warnings };
}

export async function resolveContext(agent: AgentManifest, task: Task): Promise<Resolved> {
  const parts = await collectParts(agent, task);
  const budget = CONTEXT_BUDGET[agent.model];
  const { resolved, warnings } = fitToBudget(parts, task.toggles ?? {}, budget);
  const active = resolved.filter((r) => r.on && !r.dropped);
  const join = (tier: Tier) => active.filter((r) => r.tier === tier).map((r) => r.text).join("\n");
  const packet: ContextPacket = {
    stable: join("stable"),
    relevant: join("relevant"),
    operative: join("operative"),
    tokenEstimate: active.reduce((s, r) => s + r.tokens, 0),
    sources: active.map((r) => ({ kind: r.kind, id: r.id, title: r.title, tier: r.tier, tokens: r.tokens })),
    warnings,
  };
  return { parts: resolved, packet, budget };
}

export async function buildContext(agent: AgentManifest, task: Task): Promise<ContextPacket> {
  return (await resolveContext(agent, task)).packet;
}
