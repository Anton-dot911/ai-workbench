import { db } from "../db/db";
import { TOOL_HANDLERS } from "../tools/handlers";
import type { AskRequest, ConfirmDecision, ConfirmRequest, ToolContext, ToolResult } from "../tools/types";
import { ApiError, streamMessage, type ContentBlock, type MessageRequest } from "./claude";
import { resolveContext } from "./contextBuilder";
import { costFor } from "./prices";
import { MODEL_MAP } from "./settings";
import type { AgentManifest, ContextPacket, Run, Task } from "./types";

export interface ToolEvent {
  name: string;
  status: "start" | "ok" | "error";
}

export interface RunUi {
  token: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onTool?: (e: ToolEvent) => void;
  confirm?: (r: ConfirmRequest) => Promise<ConfirmDecision>;
  ask?: (r: AskRequest) => Promise<string>;
}

export interface RunResult {
  run: Run;
  text: string;
  stopReason: string | null;
}

/** Запобіжник від нескінченного циклу «модель → інструмент → модель». */
export const MAX_STEPS = 12;

/** Пакет контексту розкладається так, щоб стабільна частина йшла першою і кешувалась (prompt caching). */
export function buildRequest(agent: AgentManifest, ctx: ContextPacket, task: Task): MessageRequest {
  // Інструкції агента + профіль і закріплені факти: незмінний префікс, що кешується.
  // Мінімальний розмір кешу ≈1024 токени: якщо префікс коротший, мітка просто не діє.
  const prefix = ctx.stable ? `${agent.systemPrompt}\n\n${ctx.stable}` : agent.systemPrompt;
  const system: NonNullable<MessageRequest["system"]> = [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }];

  const content: { type: "text"; text: string }[] = [];
  const context = [ctx.relevant, ctx.operative].filter(Boolean).join("\n");
  if (context) content.push({ type: "text", text: `<context>\n${context}\n</context>` });
  content.push({ type: "text", text: `<task>\n${task.input}\n</task>` });

  return {
    model: MODEL_MAP[agent.model],
    max_tokens: agent.maxTokens,
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
    system,
    ...(agent.tools.length ? { tools: agent.tools } : {}),
    // Агент зі структурованим виходом зобов'язаний викликати завершальний інструмент.
    ...(agent.finalTool ? { tool_choice: { type: "tool", name: agent.finalTool, disable_parallel_tool_use: true } } : {}),
    messages: [{ role: "user", content }],
  };
}

async function execTool(call: ContentBlock, ctx: ToolContext): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[call.name ?? ""];
  if (!handler) return { content: `Невідомий інструмент: ${call.name}`, isError: true };
  try {
    let decision: ConfirmDecision | undefined;
    if (handler.plan) {
      const plan = await handler.plan(call.input, ctx);
      if (plan.error) return { content: plan.error, isError: true };
      if (plan.confirm) {
        if (!ctx.ui.confirm) return { content: "Підтвердження недоступне, зміну не внесено.", isError: true };
        decision = await ctx.ui.confirm(plan.confirm);
        if (!decision.approve) return { content: "Користувач відхилив зміну.", isError: true };
      }
    }
    return await handler.run(call.input, ctx, decision);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

/**
 * Цикл tool use: модель викликає інструменти, поки не поверне відповідь без tool_use.
 * Дії зі змінами проходять через підтвердження користувача (diff) всередині обробників інструментів.
 */
export async function runAgent(agent: AgentManifest, task: Task, ui: RunUi): Promise<RunResult> {
  const { packet: ctx } = await resolveContext(agent, task);
  const req = buildRequest(agent, ctx, task);
  const messages = [...req.messages];
  const toolCtx: ToolContext = { signal: ui.signal, calls: {}, ui: { confirm: ui.confirm, ask: ui.ask } };
  let finalOutput: string | null = null;

  const total = { input: 0, output: 0, cacheRead: 0, costUsd: 0 };
  const toolCalls: { name: string; ok: boolean }[] = [];
  let text = "";
  let gap = false;
  let stopReason: string | null = null;
  let steps = 0;

  while (steps < MAX_STEPS) {
    if (ui.signal?.aborted) throw new ApiError("aborted", "Зупинено");
    steps++;
    const res = await streamMessage({ ...req, messages }, {
      token: ui.token,
      signal: ui.signal,
      onText: (d) => {
        if (gap) {
          text += "\n\n";
          ui.onText?.("\n\n");
          gap = false;
        }
        text += d;
        ui.onText?.(d);
      },
    });
    gap = res.text.length > 0;
    stopReason = res.stopReason;
    total.input += res.usage.input_tokens ?? 0;
    total.output += res.usage.output_tokens ?? 0;
    total.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    total.costUsd += costFor(req.model, res.usage);

    const calls = res.content.filter((b) => b.type === "tool_use");
    if (res.stopReason !== "tool_use" || calls.length === 0) break;

    // API не приймає порожніх текстових блоків у історії.
    messages.push({ role: "assistant", content: res.content.filter((b) => b.type !== "text" || (b.text ?? "").length > 0) });
    const results: unknown[] = [];
    for (const call of calls) {
      const name = call.name ?? "?";
      toolCtx.calls![name] = (toolCtx.calls![name] ?? 0) + 1;
      ui.onTool?.({ name, status: "start" });
      const out = await execTool(call, toolCtx);
      if (!out.isError && TOOL_HANDLERS[name]?.terminal) finalOutput = out.content;
      toolCalls.push({ name: call.name ?? "?", ok: !out.isError });
      ui.onTool?.({ name: call.name ?? "?", status: out.isError ? "error" : "ok" });
      results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });

    // Завершальний інструмент виконано успішно: його результат і є відповідь агента.
    if (finalOutput !== null) {
      stopReason = "end_turn";
      break;
    }
    if (steps >= MAX_STEPS) throw new Error(`Агент перевищив ліміт кроків (${MAX_STEPS}). Спробуйте уточнити задачу.`);
  }

  const output = finalOutput !== null ? finalOutput : text.trim();
  const run: Run = {
    id: crypto.randomUUID(),
    agentId: agent.id,
    input: task.input,
    contextSnapshot: ctx,
    output,
    usage: total,
    chainId: task.chainId,
    createdAt: Date.now(),
    steps,
    toolCalls,
  };
  await db.runs.add(run);
  return { run, text: output, stopReason };
}
