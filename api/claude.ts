// Проксі до Anthropic Messages API (Vercel Function, Node.js runtime, Web Handler).
//   GET  /api/claude → стан витрат і таблиця цін (для екрана «Налаштування»)
//   POST /api/claude → пересилає запит до api.anthropic.com/v1/messages (стрімінг як є)
// Захист: токен застосунку, білий список моделей, ліміт max_tokens, денний і місячний ліміти витрат.
import { waitUntil } from "@vercel/functions";
import { costUsd, resolvePrices, WEB_SEARCH_USD, type PriceTable, type Usage } from "../shared/pricing.js";
import { safeEqual } from "./_lib/auth.js";
import { ConfigError, createStore, readLimits, readSpent, recordSpend, type BudgetStore, type Limits } from "./_lib/budget.js";
import { UsageTracker } from "./_lib/usage.js";

const UPSTREAM = "https://api.anthropic.com/v1/messages";
const MAX_BODY_BYTES = 2_000_000;

type Env = Record<string, string | undefined>;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(status: number, type: string, message: string): Response {
  return reply(status, { error: { type, message } });
}

interface Ctx {
  env: Env;
  store: BudgetStore;
  limits: Limits;
  prices: PriceTable;
  tz: string;
  maxOut: number;
  maxSearches: number;
}

function authorize(req: Request, env: Env): Response | null {
  const expected = env.APP_TOKEN;
  if (!expected) return fail(500, "config_error", "APP_TOKEN не налаштований. Запити заблоковано.");
  const got = req.headers.get("x-app-token") ?? "";
  if (!safeEqual(got, expected)) return fail(401, "unauthorized", "Невірний токен доступу.");
  return null;
}

function setup(env: Env): Ctx {
  if (!env.ANTHROPIC_API_KEY) throw new ConfigError("ANTHROPIC_API_KEY не налаштований.");
  const maxOut = Number(env.MAX_OUTPUT_TOKENS ?? 16000);
  if (!Number.isInteger(maxOut) || maxOut <= 0) throw new ConfigError("MAX_OUTPUT_TOKENS: очікується додатне ціле число");
  const maxSearches = Number(env.MAX_WEB_SEARCHES ?? 10);
  if (!Number.isInteger(maxSearches) || maxSearches < 0) throw new ConfigError("MAX_WEB_SEARCHES: очікується невід'ємне ціле число");
  return {
    env,
    maxSearches,
    store: createStore(env),
    limits: readLimits(env),
    prices: resolvePrices(env.PRICES_JSON),
    tz: env.BUDGET_TZ || "Europe/Kyiv",
    maxOut,
  };
}

function configFailure(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  return fail(500, "config_error", message);
}

export async function GET(req: Request): Promise<Response> {
  const env = process.env as Env;
  const denied = authorize(req, env);
  if (denied) return denied;
  let ctx: Ctx;
  try {
    ctx = setup(env);
  } catch (e) {
    return configFailure(e);
  }
  const spent = await readSpent(ctx.store, new Date(), ctx.tz);
  return reply(200, { ok: true, spent, limits: ctx.limits, prices: ctx.prices, tz: ctx.tz });
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env as Env;
  const denied = authorize(req, env);
  if (denied) return denied;

  let ctx: Ctx;
  try {
    ctx = setup(env);
  } catch (e) {
    return configFailure(e);
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return fail(413, "request_too_large", "Запит завеликий.");
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "invalid_request", "Тіло запиту має бути JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "invalid_request", "Очікується JSON-об'єкт.");
  if (typeof body.model !== "string" || !(body.model in ctx.prices)) {
    return fail(400, "model_not_allowed", `Модель не дозволена: ${String(body.model)}. Дозволені: ${Object.keys(ctx.prices).join(", ")}.`);
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > ctx.maxOut) {
    return fail(400, "invalid_request", `max_tokens має бути цілим числом від 1 до ${ctx.maxOut}.`);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return fail(400, "invalid_request", "messages не може бути порожнім.");

  // Серверні інструменти: дозволено лише базовий веб-пошук із обов'язковим max_uses (інакше невидимі витрати).
  let searchBudget = 0;
  if (body.tools !== undefined && !Array.isArray(body.tools)) return fail(400, "invalid_request", "tools має бути масивом.");
  for (const t of body.tools ?? []) {
    if (!t || typeof t !== "object") return fail(400, "invalid_request", "Некоректний опис інструмента.");
    if (t.type === undefined || t.type === "custom") continue;
    if (t.type !== "web_search_20250305") return fail(400, "tool_not_allowed", `Серверний інструмент не дозволено: ${String(t.type)}.`);
    if (!Number.isInteger(t.max_uses) || t.max_uses < 1 || t.max_uses > ctx.maxSearches) {
      return fail(400, "invalid_request", `web_search потребує max_uses від 1 до ${ctx.maxSearches}.`);
    }
    searchBudget += t.max_uses * WEB_SEARCH_USD;
  }

  // Ліміти: перевіряємо вже витрачене і найгірший випадок для цього запиту (токени + пошуки).
  const now = new Date();
  const spent = await readSpent(ctx.store, now, ctx.tz);
  const worst = costUsd(body.model, { input_tokens: Math.ceil(text.length / 2.5), output_tokens: body.max_tokens }, ctx.prices) + searchBudget;
  if (spent.dayUsd + worst > ctx.limits.dayUsd) {
    return fail(429, "budget_exceeded", `Денний ліміт витрат: витрачено $${spent.dayUsd.toFixed(2)} із $${ctx.limits.dayUsd.toFixed(2)}.`);
  }
  if (spent.monthUsd + worst > ctx.limits.monthUsd) {
    return fail(429, "budget_exceeded", `Місячний ліміт витрат: витрачено $${spent.monthUsd.toFixed(2)} із $${ctx.limits.monthUsd.toFixed(2)}.`);
  }

  const headers: Record<string, string> = {
    "x-api-key": ctx.env.ANTHROPIC_API_KEY as string,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  const beta = req.headers.get("anthropic-beta");
  if (beta) headers["anthropic-beta"] = beta;

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, { method: "POST", headers, body: text, signal: req.signal });
  } catch {
    return fail(502, "upstream_unreachable", "Не вдалося зв'язатися з Anthropic.");
  }

  if (!upstream.ok) {
    // Помилки не тарифікуються: віддаємо як є.
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  }

  let recorded = false;
  const record = async (usage: Usage): Promise<void> => {
    if (recorded) return;
    recorded = true;
    try {
      await recordSpend(ctx.store, costUsd(body.model, usage, ctx.prices), new Date(), ctx.tz);
    } catch (e) {
      console.error("Не вдалося записати витрати", e);
    }
  };

  if (body.stream !== true) {
    const data: any = await upstream.json();
    await record(data?.usage ?? { input_tokens: 0, output_tokens: 0 });
    return reply(200, data);
  }

  if (!upstream.body) return fail(502, "upstream_empty", "Порожня відповідь від Anthropic.");
  const reader = upstream.body.getReader();
  const tracker = new UsageTracker();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await record(tracker.result());
          return;
        }
        tracker.push(value);
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
        await record(tracker.result());
      }
    },
    cancel(reason) {
      // Клієнт обірвав з'єднання: зупиняємо upstream і все одно враховуємо витрати.
      const work = Promise.all([reader.cancel(reason).catch(() => {}), record(tracker.result())]);
      try {
        waitUntil(work);
      } catch {
        /* поза Vercel: проміс і так виконається */
      }
      return work.then(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
