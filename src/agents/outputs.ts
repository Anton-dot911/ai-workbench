import { z } from "zod";
import type { Edit } from "../tools/edits";

// Розбір структурованого виходу агентів (JSON, який повертає завершальний інструмент).

export const ReviewIssue = z.object({
  severity: z.enum(["high", "medium", "low"]),
  category: z.enum(["language", "facts", "logic", "style", "code", "brief"]),
  quote: z.string(),
  problem: z.string(),
  suggestion: z.string(),
  replacement: z.string().optional(),
  source: z.string().optional(),
});
export type ReviewIssue = z.infer<typeof ReviewIssue>;

export const ReviewOutput = z.object({
  verdict: z.enum(["ok", "needs_changes"]),
  score: z.number().int().min(0).max(10),
  summary: z.string(),
  issues: z.array(ReviewIssue),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export const PostVariant = z.object({
  text: z.string(),
  hashtags: z.array(z.string()),
  charCount: z.number().optional(),
  over: z.number().optional(),
  tagIssue: z.string().optional(),
});
export type PostVariant = z.infer<typeof PostVariant>;

export const PostsOutput = z.object({
  platform: z.enum(["telegram", "linkedin", "x", "facebook"]),
  variants: z.array(PostVariant).min(1),
});
export type PostsOutput = z.infer<typeof PostsOutput>;

function parseWith<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
export const parseReview = (text: string): ReviewOutput | null => parseWith(ReviewOutput, text);
export const parsePosts = (text: string): PostsOutput | null => parseWith(PostsOutput, text);

/** Зауваження з готовою заміною → правки для `apply_edits` (користувач побачить diff). */
export function reviewToEdits(issues: ReviewIssue[]): Edit[] {
  return issues
    .filter((i) => i.replacement !== undefined && i.quote.trim())
    .map((i) => ({ find: i.quote, replace: i.replacement as string, reason: i.problem }));
}

/** Короткий текстовий підсумок виходу (для історії сесії). */
export function summarizeOutput(agentId: string, output: string): string {
  if (agentId === "review") {
    const r = parseReview(output);
    return r ? `Перевірка: ${r.verdict === "ok" ? "без зауважень" : "потрібні правки"}, ${r.score}/10. ${r.summary}` : output;
  }
  if (agentId === "posts") {
    const p = parsePosts(output);
    return p ? `Пост для ${p.platform}, варіантів ${p.variants.length}. Перший: ${p.variants[0].text}` : output;
  }
  return output;
}
