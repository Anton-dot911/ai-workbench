// Хмарна копія особистих даних (профіль, факти, артефакти) у вашому Redis.
//   GET  /api/backup?meta=1 → {savedAt, counts} (без даних)
//   GET  /api/backup        → {savedAt, counts, data}
//   POST /api/backup        → зберігає копію (попередня лишається як backup:prev)
// Запуски (журнал) у копію не входять: вони великі й відтворювані.
import { safeEqual } from "./_lib/auth.js";
import { ConfigError } from "./_lib/budget.js";
import { createKv } from "./_lib/kv.js";

type Env = Record<string, string | undefined>;
// Запас під обмеження розміру запиту безкоштовного Redis (значення подвійно екранується в REST-запиті).
const MAX_BYTES = 500_000;
const LATEST = "backup:latest";
const PREV = "backup:prev";

interface Counts {
  profile: boolean;
  memory: number;
  artifacts: number;
}
interface Record_ {
  savedAt: number;
  counts: Counts;
  data: unknown;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, type: string, message: string): Response => reply(status, { error: { type, message } });

function authorize(req: Request, env: Env): Response | null {
  if (!env.APP_TOKEN) return fail(500, "config_error", "APP_TOKEN не налаштований.");
  return safeEqual(req.headers.get("x-app-token") ?? "", env.APP_TOKEN) ? null : fail(401, "unauthorized", "Невірний токен доступу.");
}

function kvOrFail(env: Env) {
  try {
    return { kv: createKv(env) };
  } catch (e) {
    return { error: fail(500, "config_error", e instanceof ConfigError || e instanceof Error ? e.message : String(e)) };
  }
}

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const nonEmptyArr = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** Чи заповнено профіль хоч одним змістовним полем (мова за замовчуванням не рахується). */
function profileFilled(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  return nonEmptyStr(p.name) || nonEmptyStr(p.tone) || nonEmptyStr(p.audience) || nonEmptyArr(p.expertise) || nonEmptyArr(p.brandWords) || nonEmptyArr(p.codingPrefs?.stack) || nonEmptyStr(p.codingPrefs?.style);
}

export async function GET(req: Request): Promise<Response> {
  const env = process.env as Env;
  const denied = authorize(req, env);
  if (denied) return denied;
  const k = kvOrFail(env);
  if (k.error) return k.error;
  const rec = (await k.kv!.getJson(LATEST)) as Record_ | null;
  if (!rec) return fail(404, "not_found", "Копії ще немає.");
  const meta = { ok: true, savedAt: rec.savedAt, counts: rec.counts };
  return reply(200, new URL(req.url).searchParams.has("meta") ? meta : { ...meta, data: rec.data });
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env as Env;
  const denied = authorize(req, env);
  if (denied) return denied;
  const k = kvOrFail(env);
  if (k.error) return k.error;

  const text = await req.text();
  if (text.length > MAX_BYTES) return fail(413, "too_large", "Копія завелика (понад 0,5 МБ). Видаліть зайві артефакти або зробіть експорт у файл.");
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return fail(400, "invalid_request", "Тіло запиту має бути JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail(400, "invalid_request", "Очікується JSON-об'єкт.");

  const profile = Array.isArray(data.profile) ? data.profile[0] : data.profile;
  const counts: Counts = {
    profile: profileFilled(profile),
    memory: Array.isArray(data.memory) ? data.memory.length : 0,
    artifacts: Array.isArray(data.artifacts) ? data.artifacts.length : 0,
  };
  // Порожню копію не приймаємо: вона могла б затерти справжню.
  if (!counts.profile && counts.memory === 0 && counts.artifacts === 0) return fail(400, "empty_backup", "Копія порожня, її не збережено.");

  const cur = await k.kv!.getJson(LATEST);
  if (cur) await k.kv!.setJson(PREV, cur);
  const savedAt = Date.now();
  await k.kv!.setJson(LATEST, { savedAt, counts, data } satisfies Record_);
  return reply(200, { ok: true, savedAt, counts });
}
