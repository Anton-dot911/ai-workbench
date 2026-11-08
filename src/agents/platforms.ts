// Правила платформ як дані, а не як текст у промпті: їх легко редагувати, а перевіряє їх код, не модель.

export type PlatformId = "telegram" | "linkedin" | "x" | "facebook";

export interface PlatformRules {
  name: string;
  maxChars: number;
  /** Допустима кількість хештегів [мін, макс]. */
  tags: [number, number];
  /** Скільки перших символів видно до «ще» (LinkedIn). */
  hookChars?: number;
  recommended?: number;
}

export const PLATFORMS: Record<PlatformId, PlatformRules> = {
  telegram: { name: "Telegram", maxChars: 4096, tags: [0, 3] },
  linkedin: { name: "LinkedIn", maxChars: 3000, tags: [3, 5], hookChars: 210 },
  x: { name: "X", maxChars: 280, tags: [0, 2] },
  facebook: { name: "Facebook", maxChars: 63206, tags: [0, 5], recommended: 500 },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[];

/** Опис правил для системного промпту (генерується з даних вище). */
export function rulesForPrompt(): string {
  return PLATFORM_IDS.map((id) => {
    const p = PLATFORMS[id];
    const extra = [p.hookChars ? `перші ${p.hookChars} символів мають зацікавити (їх видно до «ще»)` : "", p.recommended ? `оптимально до ${p.recommended}` : ""].filter(Boolean).join("; ");
    return `- ${id} (${p.name}): до ${p.maxChars} символів, хештегів ${p.tags[0]}–${p.tags[1]}${extra ? "; " + extra : ""}`;
  }).join("\n");
}

export const normalizeTag = (t: string): string => "#" + t.trim().replace(/^#+/, "").replace(/\s+/g, "");

/** Кількість символів поста разом з хештегами (як їх бачить платформа). */
export function postLength(text: string, hashtags: string[]): number {
  const tags = hashtags.join(" ");
  return Array.from(text).length + (tags ? 2 + Array.from(tags).length : 0);
}

export interface VariantCheck {
  count: number;
  max: number;
  /** На скільки символів перевищено ліміт (0, якщо в межах). */
  over: number;
  tagIssue?: string;
}

export function checkVariant(platform: PlatformId, text: string, hashtags: string[]): VariantCheck {
  const p = PLATFORMS[platform];
  const count = postLength(text, hashtags);
  const [min, max] = p.tags;
  const n = hashtags.length;
  const tagIssue = n < min || n > max ? `хештегів ${n}, для ${p.name} потрібно ${min === max ? min : `${min}–${max}`}` : undefined;
  return { count, max: p.maxChars, over: Math.max(0, count - p.maxChars), tagIssue };
}
