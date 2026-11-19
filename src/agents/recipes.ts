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

/** Extract machine-readable validatePackage report. */
function packageValidation(text: string): { errors: number; warnings: number } | null {
  const clean = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
  try {
    const value = JSON.parse(clean);
    if (typeof value.errors === "number" && typeof value.warnings === "number") return value;
  } catch { /* report may be embedded in prose */ }
  const match = text.match(/(?:errors|помилок)\s*[:=]\s*(\d+)/i);
  return match ? { errors: Number(match[1]), warnings: 0 } : null;
}

export const specificationPackage: Recipe = {
  id: "specification-package",
  name: "Пакет специфікацій",
  description: "Вимоги → архітектура → модель даних → задачі → validatePackage; за помилок — виправлення й повторна перевірка.",
  commands: ["/пакет-специфікацій", "/spec-package"],
  examples: ["пакет-специфікацій: модуль імпорту бази", "spec-package: offline queue"],
  build(input) {
    const topic = input.trim();
    if (!topic) throw new Error("Вкажіть проєкт або модуль для пакета специфікацій.");
    const stages = [
      `Проєкт/модуль: ${topic}. Створи пакет через create_package (якщо його ще немає; projectId kebab-case). Суттєві невідомі уточни через ask_user. Виконай лише set_requirements. Розрізняй confirmed, preference, assumption. Поверни packageId і короткий звіт.`,
      `Продовж пакет ${topic}, packageId бери з <upstream>. Виконай лише set_architecture: межі, потоки, рішення, компоненти. Не змінюй вимоги. Поверни короткий звіт.`,
      `Продовж пакет ${topic}, packageId бери з <upstream>. Виконай лише set_data_model, узгоджено з вимогами й архітектурою. Якщо дані не потрібні, entities=[] допустимо. Не змінюй інші розділи.`,
      `Продовж пакет ${topic}, packageId бери з <upstream>. Виконай лише set_tasks: малі перевірювані задачі, покриття must-вимог, залежності, файли, acceptance і verification. Не змінюй інші розділи. Після цього виклич check_package. Поверни повний JSON-звіт check_package (errors, warnings, issues, readyForReview), без обрізання.`,
    ];
    const validation = `Виконай check_package для пакета ${topic}, нічого не змінюй. Поверни повний JSON-звіт (errors, warnings, issues, readyForReview).`;
    const fix = `Пакет ${topic}: виправ за звітом у <upstream> всі помилки та warnings, що можна усунути без нових припущень. Стабільні ID не перенумеровуй, коректні розділи не переписуй. Виклич потрібні set_* інструменти, потім check_package. Поверни повний JSON-звіт.`;
    return [
      { agentId: "engineer", instruction: stages[0] },
      { agentId: "engineer", instruction: stages[1] },
      { agentId: "engineer", instruction: stages[2] },
      { agentId: "engineer", instruction: stages[3] },
      { agentId: "engineer", instruction: validation, retry: {
        max: 1,
        needed: (result) => (packageValidation(result.text)?.errors ?? 0) > 0,
        fix: { agentId: "engineer", instruction: fix, upstreamFrom: (_done, trigger) => trigger.text },
      } },
    ];
  },
};

\nexport const RECIPES: Recipe[] = [postWithResearch, specificationPackage];

export const getRecipe = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);

/**
 * Розбирає команду рецепта на початку задачі: «/пост-з-пошуком linkedin: тема».
 * Слеш необов'язковий: на українській розкладці iPhone «/» лежить на цифровій сторінці, а автоверхній регістр
 * робить із першого слова «Пост-з-пошуком». Назви рецептів із дефісами, тож не плутаються зі звичайним текстом задачі
 * (на відміну від коротких команд агентів на кшталт «пост» чи «код», які лишаються лише зі слешем).
 */
export function parseRecipeCommand(input: string): { recipe: Recipe; rest: string } | null {
  const m = input.trim().match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/^\//, "");
  const recipe = RECIPES.find((r) => r.commands.some((c) => c.replace(/^\//, "") === name));
  return recipe ? { recipe, rest: m[2].trim() } : null;
}
