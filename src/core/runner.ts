import { AGENTS } from "../agents/registry";
import { db } from "../db/db";
import { TOOL_HANDLERS } from "../tools/handlers";
import type { AskRequest, ConfirmDecision, ConfirmRequest, ToolContext, ToolResult, HandoffRequest } from "../tools/types";
import { ApiError, streamMessage, type ContentBlock, type MessageRequest } from "./claude";
import { renderCitations, type Source } from "./citations";
import { neutralize, resolveContext, untrusted } from "./contextBuilder";
import { worstCaseRunUsd } from "./estimate";
import { costFor } from "./prices";
import { MODEL_MAP } from "./settings";
import type { AgentManifest, ContextPacket, HandoffRecord, Run, Task } from "./types";

export interface ToolEvent {
  name: string;
  status: "start" | "ok" | "error";
  /** Напр. пошуковий запит або код помилки. */
  detail?: string;
}

export interface RunUi {
  token: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onTool?: (e: ToolEvent) => void;
  confirm?: (r: ConfirmRequest) => Promise<ConfirmDecision>;
  ask?: (r: AskRequest) => Promise<string>;
  /** Підтвердження передачі завдання іншому агентові (з оцінкою вартості). Без обробника передача відхиляється. */
  confirmHandoff?: (r: HandoffRequest) => Promise<boolean>;
}

export interface RunResult {
  run: Run;
  text: string;
  stopReason: string | null;
  sources: Source[];
}

/** Запобіжник від нескінченного циклу «модель → інструмент → модель». */
export const MAX_STEPS = 12;
/** Верхня межа, яку може запросити маніфест агента (агенти з довгим робочим процесом, наприклад «Інженер»). */
export const MAX_STEPS_HARD = 30;

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
    system,
    ...(agent.tools.length || agent.serverTools?.length ? { tools: [...agent.tools, ...(agent.serverTools ?? [])] } : {}),
    // Агент зі структурованим виходом зобов'язаний викликати завершальний інструмент.
    ...(agent.finalTool ? { tool_choice: { type: "auto", disable_parallel_tool_use: true } } : {}),
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
/** Скільки символів результату вкладеного запуску повертається батьківському агентові. */
export const MAX_HANDOFF_RESULT_CHARS = 20_000;

/** Результат передачі як tool_result: джерела списком; дані з інтернету обгорнуто як недовірений вміст (інваріант 17). */
export function handoffContent(web: boolean, text: string, sources: Source[]): string {
  let body = text.length > MAX_HANDOFF_RESULT_CHARS ? `${text.slice(0, MAX_HANDOFF_RESULT_CHARS)}\n…(результат скорочено)` : text;
  if (sources.length) body += `\n\nДжерела:\n${sources.map((s, i) => `[${i + 1}] ${s.title || s.url} — ${s.url}`).join("\n")}`;
  const safe = neutralize(body);
  return web ? untrusted("web_derived", safe) : safe;
}

export async function runAgent(agent: AgentManifest, task: Task, ui: RunUi, opts: { depth?: number; persist?: boolean } = {}): Promise<RunResult> {
  const depth = opts.depth ?? 0;
  const { packet: ctx } = await resolveContext(agent, task);
  const req = buildRequest(agent, ctx, task);
  const messages = [...req.messages];
  const toolCtx: ToolContext = {
    signal: ui.signal,
    calls: {},
    agentId: agent.id,
    // Агент із веб-пошуком читає зовнішній вміст: його пропозиції пам'яті позначаються особливо.
    origin: agent.serverTools?.length ? "web" : "user",
    ui: { confirm: ui.confirm, ask: ui.ask },
  };
  const stepBlocks: ContentBlock[][] = [];
  let finalOutput: string | null = null;

  const total = { input: 0, output: 0, cacheRead: 0, costUsd: 0, searches: 0 };
  const toolCalls: { name: string; ok: boolean }[] = [];
  const handoffs: HandoffRecord[] = [];

  /**
   * Передача завдання: підтвердження користувача з оцінкою вартості, вкладений запуск (глибина +1, без запису в журнал),
   * результат як tool_result. Вартість вкладеного запуску входить у `total` цього запуску.
   */
  const delegate = async (req: { agentId: string; instruction: string }): Promise<ToolResult> => {
    const target = AGENTS.find((a) => a.id === req.agentId);
    if (!target) return { content: `Невідомий агент: ${req.agentId}`, isError: true };
    const nested: Task = { input: req.instruction };
    if (!ui.confirmHandoff) return { content: "Підтвердження передачі недоступне, завдання не передано.", isError: true };
    const estimateUsd = worstCaseRunUsd(target, await resolveContext(target, nested), req.instruction);
    const approved = await ui.confirmHandoff({ fromAgentId: agent.id, toAgentId: target.id, instruction: req.instruction, estimateUsd, depth: depth + 1 });
    if (!approved) return { content: "Користувач відмовив у передачі завдання. Продовжуй без неї.", isError: true };
    // Текст вкладеного запуску не змішується з відповіддю цього агента; події інструментів (веб-пошук) показуються.
    const res = await runAgent(target, nested, { token: ui.token, signal: ui.signal, onTool: ui.onTool, confirm: ui.confirm, ask: ui.ask, confirmHandoff: ui.confirmHandoff }, { depth: depth + 1, persist: false });
    const u = res.run.usage;
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.costUsd += u.costUsd;
    total.searches += u.searches ?? 0;
    handoffs.push({ agentId: target.id, instruction: req.instruction, output: res.text, usage: u, ...(res.sources.length ? { sources: res.sources } : {}), depth: depth + 1 });
    const web = !!target.serverTools?.length;
    // Після читання інтернету пропозиції пам'яті цього запуску теж позначаються як веб-походження (інваріант 17).
    if (web) toolCtx.origin = "web";
    return { content: handoffContent(web, res.text, res.sources) };
  };
  if (agent.handoffTo?.length) toolCtx.handoff = { depth, allowed: agent.handoffTo, run: delegate };
  let text = "";
  let gap = false;
  let stopReason: string | null = null;
  let steps = 0;

  const maxSteps = Math.min(Math.max(agent.maxSteps ?? MAX_STEPS, 1), MAX_STEPS_HARD);
  while (steps < maxSteps) {
    if (ui.signal?.aborted) throw new ApiError("aborted", "Зупинено");
    steps++;
    const res = await streamMessage({ ...req, messages }, {
      token: ui.token,
      signal: ui.signal,
      onBlock: (block, phase) => {
        // Серверний веб-пошук: показуємо запит і результат як звичайні кроки інструментів.
        if (block.type === "server_tool_use" && phase === "stop") ui.onTool?.({ name: block.name ?? "web_search", status: "start", detail: (block.input as { query?: string } | undefined)?.query });
        if (block.type === "web_search_tool_result" && phase === "start") {
          const err = (block.content as { type?: string; error_code?: string } | undefined)?.type === "web_search_tool_result_error";
          ui.onTool?.({ name: "web_search", status: err ? "error" : "ok", detail: err ? (block.content as { error_code?: string }).error_code : undefined });
        }
      },
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
    total.searches += res.usage.server_tool_use?.web_search_requests ?? 0;
    stepBlocks.push(res.content);

    // Серверний інструмент не вклався в один запит: повертаємо відповідь без змін і продовжуємо.
    if (res.stopReason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content.filter((b) => b.type !== "text" || (b.text ?? "").length > 0) });
      if (steps >= maxSteps) throw new Error(`Агент перевищив ліміт кроків (${maxSteps}). Спробуйте уточнити задачу.`);
      continue;
    }

    const calls = res.content.filter((b) => b.type === "tool_use");
    const finalToolCalled = !agent.finalTool || calls.some((b) => b.name === agent.finalTool);

    // Нові моделі Claude не підтримують примусовий tool_choice типу "tool".
    // Для агентів зі структурованим виходом використовуємо "auto" і повторюємо
    // запит, якщо модель завершила відповідь, не викликавши обов\u0027язковий інструмент.
    if (agent.finalTool && !finalToolCalled && (res.stopReason !== "tool_use" || calls.length === 0)) {
      messages.push({
        role: "assistant",
        content: res.content.filter((b) => b.type !== "text" || (b.text ?? "").length > 0),
      });
      messages.push({
        role: "user",
        content: `Потрібно завершити задачу викликом інструмента ${agent.finalTool}. Передай через нього результат відповідно до його схеми. Не завершуй звичайним текстом.`,
      });
      if (steps >= maxSteps) {
        throw new Error(`Модель не викликала обов\u0027язковий інструмент ${agent.finalTool} після ${maxSteps} кроків.`);
      }
      continue;
    }

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
    if (steps >= maxSteps) throw new Error(`Агент перевищив ліміт кроків (${maxSteps}). Спробуйте уточнити задачу.`);
  }

  // Для агентів із веб-пошуком відповідь збирається з блоків із маркерами цитат; інакше це накопичений потік.
  const cited = agent.serverTools?.length ? renderCitations(stepBlocks) : null;
  const output = finalOutput !== null ? finalOutput : cited ? cited.text.trim() : text.trim();
  const sources = finalOutput === null && cited ? cited.sources : [];
  const run: Run = {
    id: crypto.randomUUID(),
    agentId: agent.id,
    input: task.input,
    contextSnapshot: ctx,
    output,
    usage: total,
    chainId: task.chainId,
    ...(task.chain ? { chain: task.chain } : {}),
    createdAt: Date.now(),
    steps,
    toolCalls,
    ...(sources.length ? { sources } : {}),
    ...(handoffs.length ? { handoffs } : {}),
  };
  if (opts.persist !== false) await db.runs.add(run);
  return { run, text: output, stopReason, sources };
}
