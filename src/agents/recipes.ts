import type { ChainStep, StepResult } from "../core/orchestrator";
import { parsePosts, parseReview, type PostsOutput } from "./outputs";
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

/** Останній виконаний крок агента: після виправлення це виправлений пост, а не перший варіант. */
const latest = (done: StepResult[], agentId: string): StepResult | undefined => [...done].reverse().find((d) => d.agentId === agentId);
const variantText = (v: PostsOutput["variants"][number]): string => [v.text, v.hashtags.join(" ")].filter(Boolean).join("\n\n");

/** Вхід для «Перевірки»: перший варіант поста, що вкладається в правила платформи, і звіт, за яким перевіряються факти. */
function reviewInput(done: StepResult[]): string {
  const report = latest(done, "search")?.text ?? "";
  const raw = latest(done, "posts")?.text ?? "";
  const posts = parsePosts(raw);
  const variant = posts ? (posts.variants.find((v) => !v.over && !v.tagIssue) ?? posts.variants[0]) : null;
  const post = variant ? variantText(variant) : raw;
  return `Текст для перевірки (пост${posts ? ` для ${posts.platform}` : ""}):\n${post}\n\nДжерело тверджень (звіт пошуку). Не перевіряй сам звіт: лише звіряй із ним твердження поста:\n${report}`;
}

const SEVERITY: Record<string, string> = { high: "висока", medium: "середня", low: "низька" };
const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Вхід для виправлення: звіт (єдине джерело фактів), попередні варіанти й зауваження рецензента за серйозністю. */
function fixInput(done: StepResult[], trigger: StepResult): string {
  const report = latest(done, "search")?.text ?? "";
  const posts = parsePosts(latest(done, "posts")?.text ?? "");
  const variants = posts ? posts.variants.map((v, k) => `Варіант ${k + 1}:\n${variantText(v)}`).join("\n\n") : (latest(done, "posts")?.text ?? "");
  const review = parseReview(trigger.text);
  const issues = review
    ? [...review.issues]
        .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
        .map((i, n) => `${n + 1}. [${SEVERITY[i.severity]}, ${i.category}]${i.quote ? ` «${i.quote}»` : ""}: ${i.problem} Порада: ${i.suggestion}`)
        .join("\n")
    : trigger.text;
  return `Звіт пошуку (джерело фактів, не додавай фактів поза ним):\n${report}\n\nПопередні варіанти:\n${variants}\n\nЗауваження рецензента (виправ високі й середні; низькі лише якщо це можливо за звітом):\n${issues}`;
}

export const postWithResearch: Recipe = {
  id: "post-research",
  name: "Пост з дослідженням",
  description: "Пошук → Пости (3 варіанти) → Перевірка (факти й мова); якщо потрібні правки, один раз виправляє пости й перевіряє знову.",
  commands: ["/пост-з-пошуком", "/post-research"],
  examples: ["linkedin: що нового про Web Push на iOS", "telegram: Background Sync у Safari"],
  build(input) {
    const { platform, topic } = splitPlatform(input);
    if (!topic) throw new Error("Вкажіть тему, наприклад: linkedin: що нового про Web Push на iOS");
    return [
      { agentId: "search", instruction: `Збери перевірену фактичну основу для поста на тему: ${topic}. Стисло: ключові факти з джерелами, без води.` },
      { agentId: "posts", instruction: `${platform}: ${topic}. Використай лише факти зі звіту пошуку.` },
      {
        agentId: "review",
        instruction: "facts, language",
        upstreamFrom: reviewInput,
        // Вердикт needs_changes: один раз виправити пости за зауваженнями й перевірити знову.
        retry: {
          max: 1,
          needed: (r) => parseReview(r.text)?.verdict === "needs_changes",
          fix: { agentId: "posts", instruction: `${platform}: ${topic}. Виправ варіанти за зауваженнями рецензента з <upstream>; використай лише факти зі звіту пошуку.`, upstreamFrom: fixInput },
        },
      },
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
