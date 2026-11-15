import { useEffect, useRef, useState } from "react";
import { parsePosts, parseReview, reviewToEdits, summarizeOutput, type ReviewIssue } from "../agents/outputs";
import { parseRecipeCommand, RECIPES, splitPlatform, type Recipe } from "../agents/recipes";
import { AGENTS, getAgent, parseCommand } from "../agents/registry";
import { ApiError } from "../core/claude";
import type { Resolved } from "../core/contextBuilder";
import { estimateRun } from "../core/estimate";
import { runChain, type ChainStep } from "../core/orchestrator";
import { runAgent, type ToolEvent } from "../core/runner";
import { getSession, sessionTask, setSession, useSession } from "../core/session";
import { getChainLimit } from "../core/settings";
import type { AgentManifest, Run } from "../core/types";
import { addMemory, db, saveRunAsArtifact, saveTextArtifact } from "../db/db";
import { TOOL_HANDLERS } from "../tools/handlers";
import type { AskRequest, ConfirmDecision, ConfirmRequest } from "../tools/types";
import { AskSheet } from "../ui/AskSheet";
import { ChainBar, type ChainView } from "../ui/ChainBar";
import { ConfirmSheet } from "../ui/ConfirmSheet";
import { FactForm } from "../ui/FactForm";
import { GateSheet, type GateRequest } from "../ui/GateSheet";
import { Icon } from "../ui/Icon";
import { PostCard } from "../ui/PostCard";
import { ReviewCard } from "../ui/ReviewCard";
import { SourceList } from "../ui/SourceList";
import { Sheet } from "../ui/Sheet";
import { approx, fmt, money, plural, tk } from "../ui/format";
import { toast } from "../ui/toast";

const TOOL_LABEL: Record<string, string> = {
  apply_edits: "правки",
  search_context: "пошук у пам'яті",
  read_artifact: "читання документа",
  save_artifact: "збереження",
  ask_user: "питання",
  web_search: "веб-пошук",
  propose_memory: "пропозиція пам'яті",
};

interface FeedItem {
  id: string;
  agentId: string;
  agentName: string;
  savedVariants?: number[];
  task: string;
  selection?: string;
  output: string;
  status: "running" | "done" | "stopped" | "error";
  error?: string;
  truncated?: boolean;
  tools: { name: string; status: ToolEvent["status"]; detail?: string }[];
  links?: { url: string; title: string }[];
  usage?: { input: number; output: number; cacheRead: number; costUsd: number; searches?: number };
  steps?: number;
  sources?: number;
  runId?: string;
  saved?: boolean;
  /** Заголовок ланцюга (kind = "chain"): кроки, стан, витрати. */
  kind?: "chain";
  chain?: ChainView;
  /** Крок ланцюга: у картці замість задачі показується «Крок i з n». */
  chainStep?: { index: number; total: number; label?: string };
  /** Тема ланцюга: назва збереженого артефакту й контекст «Перевірки» замість службової інструкції кроку. */
  topic?: string;
}

type Pending = { kind: "confirm"; req: ConfirmRequest; resolve: (d: ConfirmDecision) => void } | { kind: "ask"; req: AskRequest; resolve: (a: string) => void }
  | { kind: "gate"; req: GateRequest; resolve: (ok: boolean) => void };

interface Props {
  token: string;
  resolved: Resolved | null;
  onAuthError: () => void;
  onSpent: () => void;
  onOpenContext: () => void;
}

export function WorkScreen({ token, resolved, onAuthError, onSpent, onOpenContext }: Props) {
  const session = useSession();
  const agent = getAgent(session.agentId);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [fragOpen, setFragOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState<FeedItem | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const abort = useRef<AbortController | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const lastNonce = useRef(session.runNonce);

  const patch = (id: string, fn: (i: FeedItem) => Partial<FeedItem>) =>
    setFeed((f) => f.map((i) => (i.id === id ? { ...i, ...fn(i) } : i)));

  useEffect(() => {
    const el = feedRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [feed]);

  // Запуск, ініційований з екрана «Контекст».
  useEffect(() => {
    if (session.runNonce !== lastNonce.current) {
      lastNonce.current = session.runNonce;
      void send();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.runNonce]);

  function stop() {
    // Якщо агент чекає на підтвердження чи відповідь, відпускаємо його, щоб запуск міг завершитися.
    if (pending?.kind === "confirm") pending.resolve({ approve: false });
    if (pending?.kind === "ask") pending.resolve("");
    if (pending?.kind === "gate") pending.resolve(false);
    setPending(null);
    abort.current?.abort();
  }

  async function send() {
    const s = getSession();
    let text = s.task.trim();
    if (!text || busy) return;

    let ag = getAgent(s.agentId);
    if (text.startsWith("/")) {
      const rc = parseRecipeCommand(text);
      if (rc) {
        if (!rc.rest) {
          setSession({ task: `${rc.recipe.commands[0]} ` });
          toast(`${rc.recipe.name}: ${rc.recipe.commands[0]} ${rc.recipe.examples[0]}`);
          return;
        }
        await sendChain(rc.recipe, rc.rest, text);
        return;
      }
      const cmd = parseCommand(text);
      if (!cmd) {
        toast(`Невідома команда. Доступні: ${[...AGENTS.flatMap((a) => a.commands.slice(0, 1)), ...RECIPES.map((r) => r.commands[0])].join(", ")}`);
        return;
      }
      ag = cmd.agent;
      setSession({ agentId: ag.id });
      text = cmd.rest;
      if (!text) {
        setSession({ task: "" });
        toast(`Агент: ${ag.name}`);
        return;
      }
    }

    const task = sessionTask({ ...s, task: text });
    const id = crypto.randomUUID();
    setFeed((f) => [...f, { id, agentId: ag.id, agentName: ag.name, task: text, selection: task.selection, output: "", status: "running", tools: [] }]);
    setSession({ task: "" });
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const { run, text: out, stopReason } = await runAgent(ag, task, {
        token,
        signal: ac.signal,
        onText: (d) => patch(id, (i) => ({ output: i.output + d })),
        onTool: (e) =>
          patch(id, (i) => ({
            tools:
              e.status === "start"
                ? [...i.tools, { name: e.name, status: "start", detail: e.detail }]
                : i.tools.map((t, k) => (k === i.tools.length - 1 && t.name === e.name ? { ...t, status: e.status, ...(e.detail ? { detail: e.detail } : {}) } : t)),
          })),
        confirm: (req) => new Promise<ConfirmDecision>((resolve) => setPending({ kind: "confirm", req, resolve })),
        ask: (req) => new Promise<string>((resolve) => setPending({ kind: "ask", req, resolve })),
      });
      finishItem(id, ag, run, out, stopReason);
      setSession((st) => ({ turns: [...st.turns, { task: text, output: summarizeOutput(ag.id, out) }].slice(-8) }));
    } catch (e) {
      if (e instanceof ApiError && e.kind === "aborted") {
        patch(id, () => ({ status: "stopped" }));
      } else {
        if (e instanceof ApiError && e.kind === "auth") onAuthError();
        patch(id, () => ({ status: "error", error: e instanceof Error ? e.message : String(e) }));
        setSession((st) => ({ task: st.task || text }));
      }
    } finally {
      setBusy(false);
      abort.current = null;
      setPending(null);
      onSpent();
    }
  }

  /** Завершення запуску: підсумок, джерела, вартість; пропозиції пам'яті від агента. Спільне для одиночного запуску й кроків ланцюга. */
  function finishItem(id: string, ag: AgentManifest, run: Run, out: string, stopReason: string | null) {
    patch(id, () => ({
      status: "done",
      // Агент зі структурованим виходом: показуємо результат завершального інструмента, а не вступний текст.
      ...(ag.finalTool || ag.serverTools?.length ? { output: out } : {}),
      links: run.sources,
      runId: run.id,
      usage: run.usage,
      steps: run.steps,
      sources: run.contextSnapshot.sources.length,
      truncated: stopReason === "max_tokens",
    }));
    const proposed = (run.toolCalls ?? []).filter((t) => t.name === "propose_memory" && t.ok).length;
    if (proposed > 0) toast(`Агент запропонував фактів: ${proposed}. Підтвердьте їх у розділі «Пам'ять».`);
  }

  /** Рецепт: ланцюг агентів. Кожен крок це звичайна картка (збереження, перевірка), зверху смужка кроків і витрат. */
  async function sendChain(recipe: Recipe, input: string, raw: string) {
    let steps: ChainStep[];
    try {
      steps = recipe.build(input);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не вдалося скласти ланцюг");
      return;
    }
    const limit = getChainLimit();
    const headId = crypto.randomUUID();
    const view: ChainView = {
      recipe: recipe.name,
      topic: input,
      steps: steps.map((s) => ({ agentId: s.agentId, name: getAgent(s.agentId).name, state: "wait" })),
      status: "running",
      costUsd: 0,
      limitUsd: limit,
    };
    setFeed((f) => [...f, { id: headId, kind: "chain", chain: view, agentId: "", agentName: recipe.name, task: input, output: "", status: "running", tools: [] }]);
    setSession({ task: "" });
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    let cur = "";
    let spent = 0;
    const setChain = (fn: (c: ChainView) => ChainView) => patch(headId, (i) => ({ chain: fn(i.chain!) }));
    const setStepState = (k: number, state: ChainView["steps"][number]["state"]) => setChain((c) => ({ ...c, steps: c.steps.map((s, n) => (n === k ? { ...s, state } : s)) }));
    const gate = (req: GateRequest) => new Promise<boolean>((resolve) => setPending({ kind: "gate", req, resolve }));
    const name = (id: string) => getAgent(id).name;
    try {
      const res = await runChain(
        steps,
        {
          token,
          signal: ac.signal,
          onText: (d) => patch(cur, (i) => ({ output: i.output + d })),
          onTool: (e) =>
            patch(cur, (i) => ({
              tools:
                e.status === "start"
                  ? [...i.tools, { name: e.name, status: "start", detail: e.detail }]
                  : i.tools.map((t, k) => (k === i.tools.length - 1 && t.name === e.name ? { ...t, status: e.status, ...(e.detail ? { detail: e.detail } : {}) } : t)),
            })),
          confirm: (req) => new Promise<ConfirmDecision>((resolve) => setPending({ kind: "confirm", req, resolve })),
          ask: (req) => new Promise<string>((resolve) => setPending({ kind: "ask", req, resolve })),
          onStepStart: (i, step, ag, meta) => {
            cur = crypto.randomUUID();
            const id = cur;
            setFeed((f) => [...f, { id, agentId: ag.id, agentName: ag.name, task: step.instruction, topic: splitPlatform(input).topic, output: "", status: "running", tools: [], chainStep: { index: i, total: steps.length, ...(meta.label ? { label: meta.label } : {}) } }]);
            // Доопрацювання (виправлення, повтор) додає кроки за межами плану: смужка росте.
            setChain((c) => ({ ...c, steps: i < c.steps.length ? c.steps.map((s, n) => (n === i ? { ...s, state: "run" } : s)) : [...c.steps, { agentId: ag.id, name: ag.name + (meta.label ? ` (${meta.label})` : ""), state: "run" }] }));
          },
          onStepDone: (i, r) => {
            spent += r.run.usage.costUsd;
            finishItem(cur, getAgent(r.agentId), r.run, r.text, r.stopReason);
            setChain((c) => ({ ...c, costUsd: spent }));
            setStepState(i, "done");
          },
          confirmCost: (g) =>
            gate({
              title: "Ліміт вартості ланцюга",
              text: `Витрачено ${money(g.spent)} з ${money(g.limit)}. Наступний крок «${name(g.agentId)}» у найгіршому випадку коштує до ${money(g.estimate)}. Продовжити?`,
              yes: "Продовжити",
              no: "Зупинити",
            }),
          confirmContinue: ({ result, next }) =>
            gate({ title: "Крок завершено", text: `«${name(result.agentId)}» готово, результат вище. Продовжити до «${name(next.agentId)}»?`, yes: "Продовжити", no: "Зупинити" }),
        },
        { limitUsd: limit, label: { recipe: recipe.name, topic: input } },
      );
      setChain((c) => ({ ...c, status: res.status, costUsd: res.costUsd, steps: c.steps.map((s) => (s.state === "run" ? { ...s, state: "stopped" } : s)) }));
      // Зупинка посеред кроку: незавершена картка кроку не лишається «в роботі».
      setFeed((f) => f.map((i) => (i.chainStep && i.status === "running" ? { ...i, status: "stopped" } : i)));
    } catch (e) {
      if (e instanceof ApiError && e.kind === "auth") onAuthError();
      const msg = e instanceof Error ? e.message : String(e);
      setFeed((f) => f.map((i) => (i.chainStep && i.status === "running" ? { ...i, status: "error", error: msg } : i)));
      setChain((c) => ({ ...c, status: "error", steps: c.steps.map((s) => (s.state === "run" ? { ...s, state: "error" } : s)) }));
      setSession((st) => ({ task: st.task || raw }));
    } finally {
      setBusy(false);
      abort.current = null;
      setPending(null);
      onSpent();
    }
  }

  async function save(item: FeedItem) {
    if (!item.runId) return;
    const run = await db.runs.get(item.runId);
    if (!run) return;
    const ag = getAgent(item.agentId);
    if (ag.output.saveAs === "search_report") {
      // Звіт пошуку зберігається разом зі списком джерел.
      const list = (run.sources ?? []).map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n");
      await saveTextArtifact(run.output + (list ? `\n\n## Джерела\n${list}` : ""), "search_report", { parentRunId: run.id, title: `Пошук: ${item.topic ?? run.input}`, sources: run.sources });
    } else {
      await saveRunAsArtifact(run, ag.output.saveAs ?? "document");
    }
    patch(item.id, () => ({ saved: true }));
    toast("Збережено в бібліотеці");
  }

  /** Передає текст в агента «Перевірка»: готує фрагмент і задачу, запуск за користувачем. */
  function startReview(text: string, originTask: string, modes = "language, logic, style") {
    setSession({ agentId: "review", frag: text, task: `${modes}. Завдання, на яке відповідав текст: «${originTask}»` });
    setFragOpen(true);
    toast("Текст передано в «Перевірку». Натисніть «Запустити»");
  }

  /** Зауваження з готовою заміною → правки з diff і підтвердженням (той самий інструмент apply_edits). */
  async function applyFixes(issues: ReviewIssue[]) {
    const input = { target: "selection", edits: reviewToEdits(issues) };
    const handler = TOOL_HANDLERS.apply_edits;
    const ctx = { calls: {}, ui: { confirm: (req: ConfirmRequest) => new Promise<ConfirmDecision>((resolve) => setPending({ kind: "confirm", req, resolve })) } };
    try {
      const plan = await handler.plan!(input, ctx);
      if (plan.error) return void toast(plan.error);
      const decision = await ctx.ui.confirm(plan.confirm!);
      if (!decision.approve) return;
      const out = await handler.run(input, ctx, decision);
      toast(out.content);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не вдалося застосувати");
    }
  }

  const postText = (item: FeedItem, k: number): string => {
    const p = parsePosts(item.output);
    const v = p?.variants[k];
    return v ? v.text + (v.hashtags.length ? "\n\n" + v.hashtags.join(" ") : "") : "";
  };

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Скопійовано");
    } catch {
      toast("Не вдалося скопіювати");
    }
  }

  const est = resolved ? estimateRun(agent, resolved, session.task) : null;
  const n = resolved?.packet.sources.length ?? 0;
  const chipText = resolved && est ? `${n} ${plural(n, "джерело", "джерела", "джерел")} · ≈${tk(est.tokens)} ток. · ${approx(est.costUsd)}` : "Збираю контекст…";

  return (
    <div className="work">
      <div className="feed" ref={feedRef}>
        {feed.length === 0 && (
          <div className="empty">
            <h2>{agent.name}</h2>
            <p>{agent.description}</p>
            <p>Введіть задачу внизу або почніть із прикладу:</p>
            <div className="exs">
              {agent.examples.map((x) => (
                <button key={x} className="ex" onClick={() => setSession({ task: x })}>
                  {x}
                </button>
              ))}
            </div>
            <p className="note">
              Змінити агента: тап по заголовку або команда на початку задачі ({agent.commands[0]}).
            </p>
            {RECIPES.map((r) => (
              <p key={r.id} className="note">
                Рецепт «{r.name}»: {r.commands[0]} {r.examples[0]}
              </p>
            ))}
          </div>
        )}

        {feed.map((it) =>
          it.kind === "chain" && it.chain ? (
            <ChainBar key={it.id} chain={it.chain} />
          ) : (
          <div key={it.id}>
            {it.chainStep ? (
              <p className="note">
                Крок {it.chainStep.index + 1}
                {it.chainStep.index < it.chainStep.total ? ` з ${it.chainStep.total}` : ""} · {it.agentName}
                {it.chainStep.label ? ` (${it.chainStep.label})` : ""}
              </p>
            ) : (
              <>
                <div className="task">
                  <span>{it.task}</span>
                </div>
                {it.selection && <p className="note right">з фрагментом, {fmt(it.selection.length)} симв.</p>}
                {AGENTS.length > 1 && <p className="note right">{it.agentName}</p>}
              </>
            )}
            <section className="card" aria-label="Відповідь агента">
              {it.tools.length > 0 && (
                <div className="chips toolrow">
                  {it.tools.map((t, k) => (
                    <span key={k} className={"tool " + t.status}>
                      {t.status === "ok" ? "✓ " : t.status === "error" ? "✕ " : "… "}
                      {TOOL_LABEL[t.name] ?? t.name}
                      {t.detail ? `: ${t.detail.length > 40 ? t.detail.slice(0, 40) + "…" : t.detail}` : ""}
                    </span>
                  ))}
                </div>
              )}
              {it.status === "running" && !it.output ? (
                <div className="wait" aria-label="Агент працює">
                  <i />
                  <i />
                  <i />
                </div>
              ) : it.status === "done" && it.agentId === "review" && parseReview(it.output) ? (
                <ReviewCard data={parseReview(it.output)!} onApply={it.chainStep ? undefined : applyFixes} />
              ) : it.status === "done" && it.agentId === "posts" && parsePosts(it.output) ? (
                <PostCard
                  data={parsePosts(it.output)!}
                  saved={it.savedVariants ?? []}
                  onSave={async (k) => {
                    await saveTextArtifact(postText(it, k), "post", { parentRunId: it.runId, fallbackTitle: it.topic ?? it.task });
                    patch(it.id, (i) => ({ savedVariants: [...(i.savedVariants ?? []), k] }));
                    toast("Збережено в бібліотеці як пост");
                  }}
                  onReview={(k) => startReview(postText(it, k), it.topic ?? it.task, "language, facts, style")}
                  onCopy={(k) => copy(postText(it, k))}
                  onReuse={(k) => {
                    setSession({ frag: postText(it, k) });
                    setFragOpen(true);
                    toast("Варіант став фрагментом для наступної задачі");
                  }}
                  onAgain={it.chainStep ? undefined : () => setSession((st) => ({ task: it.task, agentId: it.agentId, runNonce: st.runNonce + 1 }))}
                />
              ) : (
                <div className="ptext">{it.output}</div>
              )}
              {it.status === "done" && it.links && it.links.length > 0 && <SourceList sources={it.links} />}
              {it.status === "error" && (
                <div className="warn mx">
                  <Icon name="alert" size={18} />
                  <span>{it.error}</span>
                </div>
              )}
              {it.status === "stopped" && <p className="note mx">Зупинено. Відповідь неповна й не збережена в журналі.</p>}
              {it.truncated && <p className="note mx">Відповідь обрізано через ліміт довжини. Попросіть продовжити.</p>}
              {it.usage && (
                <p className="note mx tnum">
                  вхід {fmt(it.usage.input)} · вихід {fmt(it.usage.output)}
                  {it.usage.cacheRead ? ` · з кешу ${fmt(it.usage.cacheRead)}` : ""} · {money(it.usage.costUsd)}
                  {it.usage.searches ? ` · пошуків ${it.usage.searches}` : ""}
                  {it.sources !== undefined ? ` · джерел контексту ${it.sources}` : ""}
                  {it.steps && it.steps > 1 ? ` · кроків ${it.steps}` : ""}
                </p>
              )}
              {it.status === "done" && it.agentId !== "review" && it.agentId !== "posts" && (
                <div className="acts">
                  <button className="btn" disabled={it.saved} onClick={() => save(it)}>
                    <Icon name={it.saved ? "check" : "save"} size={18} />
                    {it.saved ? "Збережено" : "Зберегти"}
                  </button>
                  <button className="btn" onClick={() => setRemember(it)}>
                    <Icon name="remember" size={18} />
                    Запам'ятати
                  </button>
                  <button className="btn" onClick={() => startReview(it.output, it.topic ?? it.task)}>
                    <Icon name="review" size={18} />
                    Перевірити
                  </button>
                  <button className="btn sq" aria-label="Копіювати" onClick={() => copy(it.output)}>
                    <Icon name="copy" size={18} />
                  </button>
                  <button
                    className="btn sq"
                    aria-label="Використати як фрагмент"
                    onClick={() => {
                      setSession({ frag: it.output });
                      setFragOpen(true);
                      toast("Відповідь стала фрагментом для наступної задачі");
                    }}
                  >
                    <Icon name="reuse" size={18} />
                  </button>
                </div>
              )}
            </section>
          </div>
          ),
        )}
      </div>

      <div className="composer">
        {fragOpen && (
          <textarea
            className="field frag"
            rows={5}
            value={session.frag}
            onChange={(e) => setSession({ frag: e.target.value })}
            placeholder="Вставте текст, з яким працює агент"
            aria-label="Фрагмент тексту"
          />
        )}
        <button className="chip" onClick={onOpenContext} aria-label="Відкрити контекст запуску">
          <span className="tnum">{chipText}</span>
          <Icon name="right" size={16} />
        </button>
        <div className="inrow">
          <button className="clipbtn" aria-pressed={fragOpen} aria-label="Фрагмент тексту" onClick={() => setFragOpen((o) => !o)}>
            <Icon name="clip" size={22} />
            {session.frag.trim() && <i className="dotmark" />}
          </button>
          <input
            type="text"
            enterKeyHint="send"
            autoComplete="off"
            value={session.task}
            onChange={(e) => setSession({ task: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={agent.examples[0]}
            aria-label="Задача для агента"
          />
          {busy ? (
            <button className="go stop" onClick={stop} aria-label="Зупинити">
              <Icon name="stop" />
            </button>
          ) : (
            <button className="go" onClick={send} disabled={!session.task.trim()} aria-label="Запустити">
              <Icon name="play" />
            </button>
          )}
        </div>
      </div>

      <ConfirmSheet
        req={pending?.kind === "confirm" ? pending.req : null}
        onDecision={(d) => {
          if (pending?.kind === "confirm") pending.resolve(d);
          setPending(null);
        }}
      />
      <GateSheet
        req={pending?.kind === "gate" ? pending.req : null}
        onDecision={(ok) => {
          if (pending?.kind === "gate") pending.resolve(ok);
          setPending(null);
        }}
      />
      <AskSheet
        req={pending?.kind === "ask" ? pending.req : null}
        onAnswer={(a) => {
          if (pending?.kind === "ask") pending.resolve(a);
          setPending(null);
        }}
      />

      <Sheet open={remember !== null} title="Запам'ятати факт" onClose={() => setRemember(null)}>
        {remember && (
          <FactForm
            initial={{ text: remember.output.trim().slice(0, 500), tags: [], pinned: false }}
            hint="Залиште один факт: коротко й так, щоб він був зрозумілий без контексту. Він потрапить у пам'ять лише після вашого підтвердження."
            submitLabel="Запам'ятати"
            onCancel={() => setRemember(null)}
            onSubmit={async (v) => {
              await addMemory({ ...v, source: "agent" });
              setRemember(null);
              toast("Факт додано в пам'ять");
            }}
          />
        )}
      </Sheet>
    </div>
  );
}
