// Ціни й підрахунок вартості. Спільний модуль для проксі (api/) і клієнта (src/).
// Ціни: долари за 1 млн токенів. Звіряйте з https://platform.claude.com/docs/en/about-claude/pricing
// Перевизначення на сервері: змінна середовища PRICES_JSON.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export interface Rates {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number; // запис у 5-хвилинний кеш
}

export interface ModelPrice extends Rates {
  /** Інший тариф для дуже довгих промптів (Haiku 5.5: понад 100K токенів). */
  long?: Rates & { threshold: number };
}

export type PriceTable = Record<string, ModelPrice>;

/** Один веб-пошук Anthropic коштує $10 за 1000 запитів. */
export const WEB_SEARCH_USD = 0.01;

export const DEFAULT_PRICES: PriceTable = {
  "claude-haiku-5-5": {
    in: 0.1,
    out: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    long: { threshold: 100_000, in: 0.5, out: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function costUsd(model: string, usage: Usage, table: PriceTable = DEFAULT_PRICES): number {
  const p = table[model];
  if (!p) throw new Error(`Невідома модель: ${model}`);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const prompt = input + cacheRead + cacheWrite;
  const r: Rates = p.long && prompt > p.long.threshold ? p.long : p;
  const tokensUsd = (input * r.in + cacheWrite * r.cacheWrite + cacheRead * r.cacheRead + output * r.out) / 1e6;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return tokensUsd + searches * WEB_SEARCH_USD;
}

/** Таблиця цін: за замовчуванням вбудована, поверх неї (за наявності) PRICES_JSON. */
export function resolvePrices(json?: string | null): PriceTable {
  if (!json) return DEFAULT_PRICES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("PRICES_JSON: некоректний JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("PRICES_JSON: очікується об'єкт");
  const out: PriceTable = { ...DEFAULT_PRICES };
  for (const [model, v] of Object.entries(parsed as Record<string, any>)) {
    const ok = ["in", "out", "cacheRead", "cacheWrite"].every((k) => typeof v?.[k] === "number" && v[k] >= 0);
    if (!ok) throw new Error(`PRICES_JSON: некоректні ціни для ${model}`);
    out[model] = v as ModelPrice;
  }
  return out;
}
