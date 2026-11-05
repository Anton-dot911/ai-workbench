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
