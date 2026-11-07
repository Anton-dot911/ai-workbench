import { useEffect, useRef, useState } from "react";
import { docsAgent } from "../agents/docs";
import { ApiError } from "../core/claude";
import type { Resolved } from "../core/contextBuilder";
import { estimateRun } from "../core/estimate";
import { runAgent } from "../core/runner";
import { getSession, sessionTask, setSession, useSession } from "../core/session";
import { addMemory, db, saveRunAsArtifact } from "../db/db";
import { FactForm } from "../ui/FactForm";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";
import { approx, fmt, money, plural, tk } from "../ui/format";
import { toast } from "../ui/toast";

interface FeedItem {
  id: string;
  task: string;
  selection?: string;
  output: string;
  status: "running" | "done" | "stopped" | "error";
  error?: string;
  truncated?: boolean;
  usage?: { input: number; output: number; cacheRead: number; costUsd: number };
  sources?: number;
  runId?: string;
  saved?: boolean;
}

interface Props {
  token: string;
  resolved: Resolved | null;
  onAuthError: () => void;
  onSpent: () => void;
  onOpenContext: () => void;
}

export function WorkScreen({ token, resolved, onAuthError, onSpent, onOpenContext }: Props) {
  const session = useSession();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [fragOpen, setFragOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState<FeedItem | null>(null);
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

  async function send() {
    const s = getSession();
    const text = s.task.trim();
    if (!text || busy) return;
    const task = sessionTask(s);
    const id = crypto.randomUUID();
    setFeed((f) => [...f, { id, task: text, selection: task.selection, output: "", status: "running" }]);
    setSession({ task: "" });
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const { run, text: out, stopReason } = await runAgent(docsAgent, task, {
        token,
        signal: ac.signal,
        onText: (d) => patch(id, (i) => ({ output: i.output + d })),
      });
      patch(id, () => ({
        status: "done",
        runId: run.id,
        usage: run.usage,
        sources: run.contextSnapshot.sources.length,
        truncated: stopReason === "max_tokens",
      }));
      setSession((st) => ({ turns: [...st.turns, { task: text, output: out }].slice(-8) }));
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
      onSpent();
    }
  }

  async function save(item: FeedItem) {
    if (!item.runId) return;
    const run = await db.runs.get(item.runId);
    if (!run) return;
    await saveRunAsArtifact(run, docsAgent.output.saveAs ?? "document");
    patch(item.id, () => ({ saved: true }));
    toast("Збережено в бібліотеці");
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Скопійовано");
    } catch {
      toast("Не вдалося скопіювати");
    }
  }

  const est = resolved ? estimateRun(docsAgent, resolved, session.task) : null;
  const chipText = resolved && est ? `${resolved.packet.sources.length} ${plural(resolved.packet.sources.length, "джерело", "джерела", "джерел")} · ≈${tk(est.tokens)} ток. · ${approx(est.costUsd)}` : "Збираю контекст…";

  return (
    <div className="work">
      <div className="feed" ref={feedRef}>
        {feed.length === 0 && (
          <div className="empty">
            <h2>{docsAgent.name}</h2>
            <p>{docsAgent.description}</p>
            <p>Введіть задачу внизу або почніть із прикладу:</p>
            <div className="exs">
              {docsAgent.examples.map((x) => (
                <button key={x} className="ex" onClick={() => setSession({ task: x })}>
                  {x}
                </button>
              ))}
            </div>
          </div>
        )}

        {feed.map((it) => (
          <div key={it.id}>
            <div className="task">
              <span>{it.task}</span>
            </div>
            {it.selection && <p className="note right">з фрагментом, {fmt(it.selection.length)} симв.</p>}
            <section className="card" aria-label="Відповідь агента">
              {it.status === "running" && !it.output ? (
                <div className="wait" aria-label="Агент працює">
                  <i />
                  <i />
                  <i />
                </div>
              ) : (
                <div className="ptext">{it.output}</div>
              )}
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
                  {it.sources !== undefined ? ` · джерел контексту ${it.sources}` : ""}
                </p>
              )}
              {it.status === "done" && (
                <div className="acts">
                  <button className="btn" disabled={it.saved} onClick={() => save(it)}>
                    <Icon name={it.saved ? "check" : "save"} size={18} />
                    {it.saved ? "Збережено" : "Зберегти"}
                  </button>
                  <button className="btn" onClick={() => setRemember(it)}>
                    <Icon name="remember" size={18} />
                    Запам'ятати
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
        ))}
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
            placeholder={docsAgent.examples[0]}
            aria-label="Задача для агента"
          />
          {busy ? (
            <button className="go stop" onClick={() => abort.current?.abort()} aria-label="Зупинити">
              <Icon name="stop" />
            </button>
          ) : (
            <button className="go" onClick={send} disabled={!session.task.trim()} aria-label="Запустити">
              <Icon name="play" />
            </button>
          )}
        </div>
      </div>

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
