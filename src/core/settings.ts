import type { ModelTier } from "./types";

/** Єдине місце, де згадуються конкретні моделі. Змінюйте тільки тут (і в цінах проксі). */
export const MODEL_MAP: Record<ModelTier, string> = {
  fast: "claude-haiku-5-5",
  balanced: "claude-sonnet-5-5",
  deep: "claude-opus-5-5",
};

/** Бюджет токенів контексту на рівень моделі (використовується збирачем контексту). */
export const CONTEXT_BUDGET: Record<ModelTier, number> = { fast: 8_000, balanced: 30_000, deep: 80_000 };

const TOKEN_KEY = "wb.token";
export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

/** Ліміт вартості всього ланцюга агентів, $ (сума кроків). Зберігається на пристрої. */
export const CHAIN_LIMIT_DEFAULT_USD = 0.25;
const CHAIN_LIMIT_KEY = "wb.chainLimit";
export function getChainLimit(): number {
  const v = Number(localStorage.getItem(CHAIN_LIMIT_KEY));
  return Number.isFinite(v) && v > 0 ? v : CHAIN_LIMIT_DEFAULT_USD;
}
export const setChainLimit = (usd: number): void => {
  if (Number.isFinite(usd) && usd > 0) localStorage.setItem(CHAIN_LIMIT_KEY, String(usd));
  else localStorage.removeItem(CHAIN_LIMIT_KEY);
};
