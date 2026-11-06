import { Redis } from "@upstash/redis";

export class ConfigError extends Error {}

export interface BudgetStore {
  get(key: string): Promise<number>;
  add(key: string, micros: number, ttlSec: number): Promise<void>;
}

export interface Limits {
  dayUsd: number;
  monthUsd: number;
}

type Env = Record<string, string | undefined>;

const mem = new Map<string, number>();
export function resetMemoryStore(): void {
  mem.clear();
}

const memoryStore: BudgetStore = {
  async get(key) {
    return mem.get(key) ?? 0;
  },
  async add(key, micros) {
    mem.set(key, (mem.get(key) ?? 0) + micros);
  },
};

export function createStore(env: Env): BudgetStore {
  if (env.BUDGET_STORE === "memory") return memoryStore;
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new ConfigError("Сховище лічильника витрат не налаштоване (Upstash Redis). Запити заблоковано.");
  }
  const redis = new Redis({ url, token });
  return {
    async get(key) {
      return Number((await redis.get<number>(key)) ?? 0);
    },
    async add(key, micros, ttlSec) {
      await redis.incrby(key, micros);
      await redis.expire(key, ttlSec);
    },
  };
}

function num(env: Env, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name}: очікується додатне число`);
  return n;
}

export function readLimits(env: Env): Limits {
  return { dayUsd: num(env, "DAILY_LIMIT_USD", 3), monthUsd: num(env, "MONTHLY_LIMIT_USD", 30) };
}

/** Ключі лічильників за календарем у заданому часовому поясі. */
export function periodKeys(now: Date, tz: string): { day: string; month: string } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { day: `spend:d:${day}`, month: `spend:m:${day.slice(0, 7)}` };
}

export interface Spent {
  dayUsd: number;
  monthUsd: number;
}

export async function readSpent(store: BudgetStore, now: Date, tz: string): Promise<Spent> {
  const k = periodKeys(now, tz);
  const [d, m] = await Promise.all([store.get(k.day), store.get(k.month)]);
  return { dayUsd: d / 1e6, monthUsd: m / 1e6 };
}

export async function recordSpend(store: BudgetStore, usd: number, now: Date, tz: string): Promise<void> {
  const micros = Math.ceil(usd * 1e6);
  if (micros <= 0) return;
  const k = periodKeys(now, tz);
  await Promise.all([store.add(k.day, micros, 60 * 60 * 24 * 3), store.add(k.month, micros, 60 * 60 * 24 * 40)]);
}
