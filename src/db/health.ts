import { db } from "./db";

// Діагностика локального сховища: чи було воно очищене системою і чи працює запис.

const LS_KEY = "wb.firstSeen";

export interface StorageHealth {
  /** Коли застосунок уперше запустився в цьому сховищі. */
  firstSeen: number;
  /** Перший запуск у цьому сховищі (нічого не було). */
  fresh: boolean;
  /** IndexedDB порожня, хоча localStorage пам'ятає попередній запуск: базу очищено окремо. */
  idbWiped: boolean;
  /** localStorage порожній, хоча IndexedDB пам'ятає попередній запуск (токен теж втрачено). */
  lsCleared: boolean;
}

export async function checkHealth(now = Date.now()): Promise<StorageHealth> {
  const lsRaw = Number(localStorage.getItem(LS_KEY));
  const ls = Number.isFinite(lsRaw) && lsRaw > 0 ? lsRaw : null;
  const row = await db.meta.get("firstSeen");
  const idb = typeof row?.value === "number" ? row.value : null;

  const h: StorageHealth = { firstSeen: now, fresh: false, idbWiped: false, lsCleared: false };
  if (ls === null && idb === null) h.fresh = true;
  else if (ls !== null && idb === null) {
    h.idbWiped = true;
    h.firstSeen = ls;
  } else if (ls === null && idb !== null) {
    h.lsCleared = true;
    h.firstSeen = idb;
  } else h.firstSeen = Math.min(ls as number, idb as number);

  localStorage.setItem(LS_KEY, String(h.firstSeen));
  await db.meta.put({ key: "firstSeen", value: h.firstSeen });
  return h;
}

export interface SelfTest {
  ok: boolean;
  ms: number;
  error?: string;
}

/** Записує службовий запис, читає його назад і видаляє. Показує, чи реально працює запис у IndexedDB. */
export async function selfTest(): Promise<SelfTest> {
  const t0 = Date.now();
  try {
    const value = crypto.randomUUID();
    await db.meta.put({ key: "selftest", value });
    const back = await db.meta.get("selftest");
    await db.meta.delete("selftest");
    if (back?.value !== value) return { ok: false, ms: Date.now() - t0, error: "Запис не прочитався назад" };
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface DataCounts {
  profile: boolean;
  memory: number;
  artifacts: number;
  runs: number;
}

export async function dataCounts(): Promise<DataCounts> {
  const [p, memory, artifacts, runs] = await Promise.all([db.profile.get("me"), db.memory.count(), db.artifacts.count(), db.runs.count()]);
  return { profile: profileFilled(p), memory, artifacts, runs };
}

export function profileFilled(p: unknown): boolean {
  const x = p as { name?: string; tone?: string; audience?: string; expertise?: string[]; brandWords?: string[]; codingPrefs?: { stack?: string[]; style?: string } } | undefined;
  if (!x) return false;
  return (
    [x.name, x.tone, x.audience].some((s) => !!s?.trim()) ||
    !!x.expertise?.length ||
    !!x.brandWords?.length ||
    !!x.codingPrefs?.stack?.length ||
    !!x.codingPrefs?.style?.trim()
  );
}

export const isLocalEmpty = (c: DataCounts): boolean => !c.profile && c.memory === 0 && c.artifacts === 0;
