import type { ChainStep, StepResult } from "../core/orchestrator";
import { parsePosts } from "./outputs";
import { PLATFORM_IDS, type PlatformId } from "./platforms";

/** Рецепт: перевірений шаблон ланцюга. Це дані, ядро не змінюється, коли додається новий. */
export interface Recipe {
  id: string;
  name: string;
  description: string;
  /** Slash-команди, що запускають рецепт: `/пост-з-пошуком`. */
  commands: string[];
  examples: string[];
  /** Збирає кроки з тексту користувача; кидає зрозумілу помилку, якщо задачі не вистачає. */
  build(input: string): ChainStep[];
}

/** `linkedin: тема` → платформа й тема. Без префікса платформи це LinkedIn (як і в агента «Пости»). */
export function splitPlatform(input: string): { platform: PlatformId; topic: string } {
  const m = input.trim().match(/^(\S+?)\s*:\s*([\s\S]*)$/);
  if (m && (PLATFORM_IDS as string[]).includes(m[1].toLowerCase())) return { platform: m[1].toLowerCase() as PlatformId, topic: m[2].trim() };
  return { platform: "linkedin", topic: input.trim() };
}

/** Вхід для «Перевірки»: перший варіант поста, що вкладається в правила платформи, і звіт, за яким перевіряються факти. */
function reviewInput(done: StepResult[]): string {
  const report = done[0].text;
  const posts = parsePosts(done[1].text);
  const variant = posts ? (posts.variants.find((v) => !v.over && !v.tagIssue) ?? posts.variants[0]) : null;
  const post = variant ? [variant.text, variant.hashtags.join(" ")].filter(Boolean).join("\n\n") : done[1].text;
  return `Текст для перевірки (пост${posts ? ` для ${posts.platform}` : ""}):\n${post}\n\nДжерело тверджень (звіт пошуку). Не перевіряй сам звіт: лише звіряй із ним твердження поста:\n${report}`;
}

export const postWithResearch: Recipe = {
  id: "post-research",
  name: "Пост з дослідженням",
  description: "Пошук → Пости (3 варіанти) → Перевірка (факти й мова): тема з інтернету перетворюється на перевірений пост.",
  commands: ["/пост-з-пошуком", "/post-research"],
  examples: ["linkedin: що нового про Web Push на iOS", "telegram: Background Sync у Safari"],
  build(input) {
    const { platform, topic } = splitPlatform(input);
    if (!topic) throw new Error("Вкажіть тему, наприклад: linkedin: що нового про Web Push на iOS");
    return [
      { agentId: "search", instruction: `Збери перевірену фактичну основу для поста на тему: ${topic}. Стисло: ключові факти з джерелами, без води.` },
      { agentId: "posts", instruction: `${platform}: ${topic}. Використай лише факти зі звіту пошуку.` },
      { agentId: "review", instruction: "facts, language", upstreamFrom: reviewInput },
    ];
  },
};

export const RECIPES: Recipe[] = [postWithResearch];

export const getRecipe = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);

/** Розбирає slash-команду рецепта на початку задачі: «/пост-з-пошуком linkedin: тема». */
export function parseRecipeCommand(input: string): { recipe: Recipe; rest: string } | null {
  const m = input.trim().match(/^(\/\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const recipe = RECIPES.find((r) => r.commands.includes(cmd));
  return recipe ? { recipe, rest: m[2].trim() } : null;
}
