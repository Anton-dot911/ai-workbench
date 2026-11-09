import { Redis } from "@upstash/redis";
import { ConfigError } from "./budget.js";

type Env = Record<string, string | undefined>;

/** Мінімальне сховище JSON у Redis (для хмарної копії). */
export interface Kv {
  getJson(key: string): Promise<unknown | null>;
  setJson(key: string, value: unknown): Promise<void>;
}

const mem = new Map<string, string>();
export function resetMemoryKv(): void {
  mem.clear();
}

export function createKv(env: Env): Kv {
  if (env.BUDGET_STORE === "memory") {
    return {
      async getJson(k) {
        const v = mem.get(k);
        return v ? JSON.parse(v) : null;
      },
      async setJson(k, v) {
        mem.set(k, JSON.stringify(v));
      },
    };
  }
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (!url || !token) throw new ConfigError("Redis не налаштований. Хмарна копія недоступна.");
  const redis = new Redis({ url, token });
  return {
    async getJson(k) {
      const v = await redis.get(k);
      if (v === null || v === undefined) return null;
      // Upstash може сам розпарсити JSON-рядок.
      return typeof v === "string" ? JSON.parse(v) : v;
    },
    async setJson(k, v) {
      await redis.set(k, JSON.stringify(v));
    },
  };
}
