import { useState } from "react";
import { getAgent } from "../agents/registry";
import { groupRuns, stepLabel } from "../core/journal";
import { setSession } from "../core/session";
import type { Run } from "../core/types";
import { db } from "../db/db";
import { useLive } from "../db/useLive";
import { Icon } from "../ui/Icon";
import { RunOutput } from "../ui/RunOutput";
import { SourceList } from "../ui/SourceList";
import { money, when } from "../ui/format";
import { toast } from "../ui/toast";

export function LibraryScreen() {
  const [seg, setSeg] = useState<"artifacts" | "runs">("artifacts");
  const [open, setOpen] = useState<string | null>(null);
  const [openChains, setOpenChains] = useState<Set<string>>(new Set());
  const artifacts = useLive(() => db.artifacts.orderBy("updatedAt").reverse().toArray(), [], []);
  const runs = useLive(() => db.runs.orderBy("createdAt").reverse().limit(50).toArray(), [], []);

  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  const toggleChain = (id: string) =>
    setOpenChains((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  const agentName = (id: string) => getAgent(id).name;
  const entries = groupRuns(runs, agentName);

  /** Один запуск у журналі: заголовок, підсумок, знімок контексту й вихід. */
  const runRow = (r: Run, title: string, nested = false) => (
    <div key={r.id} className={"item" + (nested ? " nested" : "")}>
      <button className="itemhead" onClick={() => toggle(r.id)} aria-expanded={open === r.id}>
        <span className="t">
          <span className="nm">{title}</span>
          <span className="dt">
            {when(r.createdAt)} · {agentName(r.agentId)}
          </span>
        </span>
        <span className="tkn">{money(r.usage.costUsd)}</span>
        <span className={"chev" + (open === r.id ? " open" : "")}>
          <Icon name="right" size={16} />
        </span>
      </button>
      {open === r.id && (
        <>
          <p className="note mx tnum">
            вхід {r.usage.input} · вихід {r.usage.output} · джерел контексту {r.contextSnapshot.sources.length}
            {r.steps && r.steps > 1 ? ` · кроків ${r.steps}` : ""}
            {r.toolCalls?.length ? ` · інструменти: ${r.toolCalls.map((t) => t.name + (t.ok ? "" : "✕")).join(", ")}` : ""}
          </p>
          {r.contextSnapshot.sources.length > 0 && (
            <div className="chips mx">
              {r.contextSnapshot.sources.map((src) => (
                <span key={src.id}>
                  {src.title}
                  {src.tokens !== undefined ? ` · ${src.tokens}` : ""}
                </span>
              ))}
            </div>
          )}
          <RunOutput agentId={r.agentId} output={r.output} />
        </>
      )}
    </div>
  );
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Скопійовано");
    } catch {
      toast("Не вдалося скопіювати");
    }
  };

  return (
    <>
      <div className="seg card" role="tablist">
        <button role="tab" aria-selected={seg === "artifacts"} onClick={() => setSeg("artifacts")}>
          Артефакти · {artifacts.length}
        </button>
        <button role="tab" aria-selected={seg === "runs"} onClick={() => setSeg("runs")}>
          Журнал запусків · {runs.length}
        </button>
      </div>

      {seg === "artifacts" &&
        (artifacts.length === 0 ? (
          <p className="note">Тут з'являться збережені результати. Натисніть «Зберегти» під відповіддю агента.</p>
        ) : (
          <div className="list">
            {artifacts.map((a) => (
              <div key={a.id} className="item">
                <button className="itemhead" onClick={() => toggle(a.id)} aria-expanded={open === a.id}>
                  <span className="t">
                    <span className="nm">{a.title}</span>
                    <span className="dt">{when(a.updatedAt)} · {a.summary.slice(0, 70)}</span>
                  </span>
                  <span className={"chev" + (open === a.id ? " open" : "")}>
                    <Icon name="right" size={16} />
                  </span>
                </button>
                {open === a.id && (
                  <>
                    <div className="ptext">{a.content}</div>
                    {a.sources && a.sources.length > 0 && <SourceList sources={a.sources} />}
                    {a.versions.length > 1 && (
                      <div className="versions">
                        <span className="dt">Версії · {a.versions.length}</span>
                        {[...a.versions].reverse().map((v, k) => (
                          <div key={v.at + "-" + k} className="vrow">
                            <span className="tnum">
                              {when(v.at)} · {v.content.length} симв.{k === 0 ? " · поточна" : ""}
                            </span>
                            {k > 0 && (
                              <button
                                className="btn sq"
                                onClick={async () => {
                                  if (!confirm("Відкотити до цієї версії? Поточна лишиться в історії.")) return;
                                  const now = Date.now();
                                  await db.artifacts.update(a.id, {
                                    content: v.content,
                                    summary: v.content.replace(/\s+/g, " ").trim().slice(0, 200),
                                    versions: [...a.versions, { at: now, content: v.content }],
                                    updatedAt: now,
                                  });
                                  toast("Відкочено");
                                }}
                              >
                                Відкотити
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="acts">
                      <button className="btn" onClick={() => copy(a.content)}>
                        <Icon name="copy" size={18} />
                        Копіювати
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          setSession((st) => (st.extraArtifactIds.includes(a.id) ? {} : { extraArtifactIds: [...st.extraArtifactIds, a.id] }));
                          toast("Додано до контексту наступного запуску");
                        }}
                      >
                        <Icon name="tCtx" size={18} />
                        В контекст
                      </button>
                      <button
                        className="btn"
                        onClick={async () => {
                          if (confirm(`Видалити «${a.title}»? Дію не можна скасувати.`)) {
                            await db.artifacts.delete(a.id);
                            setOpen(null);
                          }
                        }}
                      >
                        <Icon name="trash" size={18} />
                        Видалити
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}

      {seg === "runs" &&
        (runs.length === 0 ? (
          <p className="note">Журнал порожній. Кожен запуск агента записується сюди разом зі знімком контексту.</p>
        ) : (
          <div className="list">
            {entries.map((e) =>
              e.kind === "run" ? (
                runRow(e.run, e.run.input.slice(0, 60))
              ) : (
                <div key={e.id} className="item chain">
                  <button className="itemhead" onClick={() => toggleChain(e.id)} aria-expanded={openChains.has(e.id)}>
                    <span className="t">
                      <span className="nm">{e.title}</span>
                      <span className="dt">
                        {when(e.at)} · {e.runs.map((r) => agentName(r.agentId)).join(" → ")}
                        {e.total && e.runs.length < e.total ? ` · виконано ${e.runs.length} з ${e.total} кроків` : ""}
                      </span>
                    </span>
                    <span className="tkn">{money(e.costUsd)}</span>
                    <span className={"chev" + (openChains.has(e.id) ? " open" : "")}>
                      <Icon name="right" size={16} />
                    </span>
                  </button>
                  {openChains.has(e.id) && <div className="sub">{e.runs.map((r, k) => runRow(r, stepLabel(r, k, agentName), true))}</div>}
                </div>
              ),
            )}
          </div>
        ))}
    </>
  );
}
