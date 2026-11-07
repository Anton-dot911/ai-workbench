import { DEFAULT_PRICES, costUsd, type PriceTable, type Usage } from "../../shared/pricing";

// Автентична таблиця цін приходить із проксі (GET /api/claude); до цього діє вбудована.
let table: PriceTable = DEFAULT_PRICES;
export const setPrices = (t: PriceTable): void => {
  table = t;
};
export const getPrices = (): PriceTable => table;

export function costFor(model: string, usage: Usage): number {
  return table[model] ? costUsd(model, usage, table) : 0;
}

/** Оцінка вартості вхідних токенів (без урахування кешу). */
export function inputCostFor(model: string, tokens: number): number {
  const p = table[model];
  return p ? (tokens * p.in) / 1e6 : 0;
}
