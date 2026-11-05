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
