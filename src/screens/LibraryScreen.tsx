import { useState } from "react";
import { setSession } from "../core/session";
import { db } from "../db/db";
import { useLive } from "../db/useLive";
import { Icon } from "../ui/Icon";
import { money, when } from "../ui/format";
import { toast } from "../ui/toast";

export function LibraryScreen() {
  const [seg, setSeg] = useState<"artifacts" | "runs">("artifacts");
  const [open, setOpen] = useState<string | null>(null);
  const artifacts = useLive(() => db.artifacts.orderBy("updatedAt").reverse().toArray(), [], []);
  const runs = useLive(() => db.runs.orderBy("createdAt").reverse().limit(50).toArray(), [], []);

  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
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
            {runs.map((r) => (
              <div key={r.id} className="item">
                <button className="itemhead" onClick={() => toggle(r.id)} aria-expanded={open === r.id}>
                  <span className="t">
                    <span className="nm">{r.input.slice(0, 60)}</span>
                    <span className="dt">{when(r.createdAt)} · {r.agentId}</span>
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
                    <div className="ptext">{r.output}</div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
    </>
  );
}
