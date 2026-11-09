import { ApiError } from "../core/claude";
import { db } from "./db";
import { dataCounts, isLocalEmpty } from "./health";
import { importBundle, parseBundle, type ImportSummary } from "./importexport";

// Хмарна копія: профіль, факти й артефакти зберігаються у вашому Redis через проксі (/api/backup).

export interface BackupMeta {
  savedAt: number;
  counts: { profile: boolean; memory: number; artifacts: number };
}

const KEY_AUTO = "wb.autobackup";
const KEY_HASH = "wb.backupHash";
const KEY_LAST = "wb.backupLast";

export const isAutoBackup = (): boolean => localStorage.getItem(KEY_AUTO) === "1";
export const setAutoBackup = (on: boolean): void => (on ? localStorage.setItem(KEY_AUTO, "1") : localStorage.removeItem(KEY_AUTO));
export const lastBackupLocal = (): { at: number; error?: string } | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY_LAST) ?? "null");
  } catch {
    return null;
  }
};

export async function buildBackup(): Promise<Record<string, unknown>> {
  const [profile, memory, artifacts] = await Promise.all([db.profile.toArray(), db.memory.toArray(), db.artifacts.toArray()]);
  return { app: "ai-workbench", schema: 1, kind: "backup", profile, memory, artifacts };
}

const hashOf = (b: Record<string, unknown>): string => {
  const s = JSON.stringify({ p: b.profile, m: b.memory, a: b.artifacts });
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
};

async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "x-app-token": token, ...(init.body ? { "content-type": "application/json" } : {}) } });
  } catch {
    throw new ApiError("network", "Немає зв'язку із сервером.");
  }
  return res;
}

async function errorOf(res: Response): Promise<ApiError> {
  let message = `Помилка сервера (${res.status})`;
  try {
    message = (await res.json())?.error?.message ?? message;
  } catch {
    /* не JSON */
  }
  return new ApiError(res.status === 401 ? "auth" : "upstream", message, res.status);
}

/** Мета-дані останньої хмарної копії; null, якщо копії ще немає. */
export async function backupMeta(token: string): Promise<BackupMeta | null> {
  const res = await call(token, "/api/backup?meta=1");
  if (res.status === 404) return null;
  if (!res.ok) throw await errorOf(res);
  const j = await res.json();
  return { savedAt: j.savedAt, counts: j.counts };
}

/**
 * Зберігає копію. Порожній локальний стан ніколи не відправляється (щоб не затерти справжню копію).
 * `force: false` пропускає відправку, якщо вміст не змінився з останнього разу.
 */
export async function pushBackup(token: string, opts: { force?: boolean } = {}): Promise<{ skipped?: "empty" | "same"; meta?: BackupMeta }> {
  const counts = await dataCounts();
  if (isLocalEmpty(counts)) return { skipped: "empty" };
  const body = await buildBackup();
  const h = hashOf(body);
  if (!opts.force && localStorage.getItem(KEY_HASH) === h) return { skipped: "same" };
  const res = await call(token, "/api/backup", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await errorOf(res);
    localStorage.setItem(KEY_LAST, JSON.stringify({ at: Date.now(), error: err.message }));
    throw err;
  }
  const j = await res.json();
  localStorage.setItem(KEY_HASH, h);
  localStorage.setItem(KEY_LAST, JSON.stringify({ at: j.savedAt }));
  return { meta: { savedAt: j.savedAt, counts: j.counts } };
}

/** Відновлює з хмарної копії: лише додає (дублі пропускаються). */
export async function restoreBackup(token: string): Promise<ImportSummary> {
  const res = await call(token, "/api/backup");
  if (res.status === 404) throw new ApiError("upstream", "Хмарної копії ще немає.", 404);
  if (!res.ok) throw await errorOf(res);
  const j = await res.json();
  const parsed = parseBundle(JSON.stringify(j.data ?? {}));
  if (!parsed.ok) throw new Error(parsed.error);
  const summary = await importBundle(parsed.bundle);
  // Після відновлення локальний стан збігається з копією: наступна автокопія не потрібна, поки нічого не змінилось.
  localStorage.setItem(KEY_HASH, hashOf(await buildBackup()));
  return summary;
}
