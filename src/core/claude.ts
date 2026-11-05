import type { PriceTable, Usage } from "../../shared/pricing";
import { parseSSE } from "./sse";

export type ApiErrorKind = "auth" | "budget" | "network" | "upstream" | "config" | "aborted";

export class ApiError extends Error {
  constructor(
    public kind: ApiErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  system?: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[];
  messages: { role: "user" | "assistant"; content: unknown }[];
  tools?: unknown[];
  temperature?: number;
  [k: string]: unknown;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}

export interface MessageResult {
  text: string;
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
}

export interface StatusResponse {
  ok: true;
  spent: { dayUsd: number; monthUsd: number };
  limits: { dayUsd: number; monthUsd: number };
  prices: PriceTable;
  tz: string;
}

const ENDPOINT = "/api/claude";

async function readError(res: Response): Promise<ApiError> {
  let type = "";
  let message = `Помилка сервера (${res.status})`;
  try {
    const j = await res.json();
    type = j?.error?.type ?? "";
    if (j?.error?.message) message = j.error.message;
  } catch {
    /* не JSON */
  }
  if (res.status === 401) return new ApiError("auth", message, 401);
  if (type === "budget_exceeded") return new ApiError("budget", message, 429);
  if (type === "config_error") return new ApiError("config", message, res.status);
  return new ApiError("upstream", message, res.status);
}

export async function getStatus(token: string, signal?: AbortSignal): Promise<StatusResponse> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, { headers: { "x-app-token": token }, signal });
  } catch {
    throw new ApiError("network", "Немає зв'язку із сервером. Перевірте мережу.");
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as StatusResponse;
}

export async function streamMessage(
  req: MessageRequest,
  opts: { token: string; signal?: AbortSignal; onText?: (delta: string) => void },
): Promise<MessageResult> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-token": opts.token },
      body: JSON.stringify({ ...req, stream: true }),
      signal: opts.signal,
    });
  } catch {
    if (opts.signal?.aborted) throw new ApiError("aborted", "Зупинено");
    throw new ApiError("network", "Немає зв'язку із сервером. Перевірте мережу.");
  }
  if (!res.ok) throw await readError(res);
  if (!res.body) throw new ApiError("upstream", "Порожня відповідь сервера.");

  const blocks: ContentBlock[] = [];
  const jsonBufs = new Map<number, string>();
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason: string | null = null;

  try {
    for await (const { data } of parseSSE(res.body)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "message_start":
          usage = { ...usage, ...(ev.message?.usage ?? {}) };
          break;
        case "content_block_start":
          blocks[ev.index] = { ...ev.content_block, ...(ev.content_block?.type === "text" ? { text: "" } : {}) };
          break;
        case "content_block_delta": {
          const b = blocks[ev.index];
          if (!b) break;
          if (ev.delta?.type === "text_delta") {
            b.text = (b.text ?? "") + ev.delta.text;
            opts.onText?.(ev.delta.text);
          } else if (ev.delta?.type === "input_json_delta") {
            jsonBufs.set(ev.index, (jsonBufs.get(ev.index) ?? "") + ev.delta.partial_json);
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks[ev.index];
          const raw = jsonBufs.get(ev.index);
          if (b && b.type === "tool_use") b.input = raw ? JSON.parse(raw) : {};
          break;
        }
        case "message_delta":
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          usage = { ...usage, ...(ev.usage ?? {}) };
          break;
        case "error":
          throw new ApiError("upstream", ev.error?.message ?? "Помилка від моделі.");
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (opts.signal?.aborted) throw new ApiError("aborted", "Зупинено");
    throw new ApiError("network", "З'єднання перервано під час відповіді.");
  }
  if (opts.signal?.aborted) throw new ApiError("aborted", "Зупинено");

  const content = blocks.filter(Boolean);
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return { text, content, stopReason, usage };
}
