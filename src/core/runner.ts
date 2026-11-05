import { db } from "../db/db";
import { streamMessage, type MessageRequest } from "./claude";
import { buildContext } from "./contextBuilder";
import { costFor } from "./prices";
import { MODEL_MAP } from "./settings";
import type { AgentManifest, ContextPacket, Run, Task } from "./types";

export interface RunUi {
  token: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface RunResult {
  run: Run;
  text: string;
  stopReason: string | null;
}

/** Пакет контексту розкладається так, щоб стабільна частина йшла першою і кешувалась (prompt caching). */
export function buildRequest(agent: AgentManifest, ctx: ContextPacket, task: Task): MessageRequest {
  const system: NonNullable<MessageRequest["system"]> = [{ type: "text", text: agent.systemPrompt }];
  // Кеш має мінімальний розмір (≈1024 токени); порожню стабільну частину не позначаємо.
  if (ctx.stable) system.push({ type: "text", text: ctx.stable, cache_control: { type: "ephemeral" } });

  const content: { type: "text"; text: string }[] = [];
  const context = [ctx.relevant, ctx.operative].filter(Boolean).join("\n");
  if (context) content.push({ type: "text", text: `<context>\n${context}\n</context>` });
  content.push({ type: "text", text: `<task>\n${task.input}\n</task>` });

  return {
    model: MODEL_MAP[agent.model],
    max_tokens: agent.maxTokens,
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
    system,
    messages: [{ role: "user", content }],
  };
}

/** Етап 1: один виклик зі стрімінгом, без інструментів. Цикл tool use додається на етапі 3. */
export async function runAgent(agent: AgentManifest, task: Task, ui: RunUi): Promise<RunResult> {
  const ctx = await buildContext(agent, task);
  const req = buildRequest(agent, ctx, task);
  const res = await streamMessage(req, { token: ui.token, signal: ui.signal, onText: ui.onText });

  const run: Run = {
    id: crypto.randomUUID(),
    agentId: agent.id,
    input: task.input,
    contextSnapshot: ctx,
    output: res.text,
    usage: {
      input: res.usage.input_tokens ?? 0,
      output: res.usage.output_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      costUsd: costFor(req.model, res.usage),
    },
    chainId: task.chainId,
    createdAt: Date.now(),
  };
  await db.runs.add(run);
  return { run, text: res.text, stopReason: res.stopReason };
}
