import { useEffect, useRef, useState } from "react";
import { docsAgent } from "../agents/docs";
import { ApiError } from "../core/claude";
import { estimateTokens } from "../core/contextBuilder";
import { runAgent } from "../core/runner";
import { db, saveRunAsArtifact } from "../db/db";
import { Icon } from "../ui/Icon";
import { fmt, money } from "../ui/format";
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
  runId?: string;
  saved?: boolean;
}

interface Props {
  token: string;
  onAuthError: () => void;
  onSpent: () => void;
}

export function WorkScreen({ token, onAuthError, onSpent }: Props) {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [task, setTask] = useState("");
  const [frag, setFrag] = useState("");
  const [fragOpen, setFragOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const patch = (id: string, fn: (i: FeedItem) => Partial<FeedItem>) =>
    setFeed((f) => f.map((i) => (i.id === id ? { ...i, ...fn(i) } : i)));

  useEffect(() => {
    const el = feedRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [feed]);

  async function send() {
    const text = task.trim();
    if (!text || busy) return;
    const id = crypto.randomUUID();
    const selection = frag.trim() || undefined;
    setFeed((f) => [...f, { id, task: text, selection, output: "", status: "running" }]);
    setTask("");
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const { run, stopReason } = await runAgent(docsAgent, { input: text, selection }, {
        token,
        signal: ac.signal,
        onText: (d) => patch(id, (i) => ({ output: i.output + d })),
      });
      patch(id, () => ({ status: "done", runId: run.id, usage: run.usage, truncated: stopReason === "max_tokens" }));
    } catch (e) {
      if (e instanceof ApiError && e.kind === "aborted") {
        patch(id, () => ({ status: "stopped" }));
      } else {
        if (e instanceof ApiError && e.kind === "auth") onAuthError();
        patch(id, () => ({ status: "error", error: e instanceof Error ? e.message : String(e) }));
        setTask((t) => t || text);
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

  const fragTokens = estimateTokens(frag + task);

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
                <button key={x} className="ex" onClick={() => setTask(x)}>
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
                </p>
              )}
              {it.status === "done" && (
                <div className="acts">
                  <button className="btn" disabled={it.saved} onClick={() => save(it)}>
                    <Icon name={it.saved ? "check" : "save"} size={18} />
                    {it.saved ? "Збережено" : "Зберегти"}
                  </button>
                  <button className="btn sq" aria-label="Копіювати" onClick={() => copy(it.output)}>
                    <Icon name="copy" size={18} />
                  </button>
                  <button
                    className="btn sq"
                    aria-label="Використати як фрагмент"
                    onClick={() => {
                      setFrag(it.output);
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
            value={frag}
            onChange={(e) => setFrag(e.target.value)}
            placeholder="Вставте текст, з яким працює агент"
            aria-label="Фрагмент тексту"
          />
        )}
        <button className="chip" onClick={() => setFragOpen((o) => !o)} aria-expanded={fragOpen}>
          <span className="tnum">
            {frag.trim() ? `Фрагмент: ${fmt(frag.length)} симв.` : "Додати фрагмент"} · запит ≈{fmt(fragTokens)} ток.
          </span>
          <Icon name="right" size={16} />
        </button>
        <div className="inrow">
          <input
            type="text"
            enterKeyHint="send"
            autoComplete="off"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={docsAgent.examples[0]}
            aria-label="Задача для агента"
          />
          {busy ? (
            <button className="go stop" onClick={() => abort.current?.abort()} aria-label="Зупинити">
              <Icon name="stop" />
            </button>
          ) : (
            <button className="go" onClick={send} disabled={!task.trim()} aria-label="Запустити">
              <Icon name="play" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
