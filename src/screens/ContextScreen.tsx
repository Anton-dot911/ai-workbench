import { useState } from "react";
import type { AgentManifest, Tier } from "../core/types";
import { renderPart, type Resolved, type ResolvedPart } from "../core/contextBuilder";
import { estimateRun } from "../core/estimate";
import { setSession, useSession } from "../core/session";
import { db } from "../db/db";
import { useLive } from "../db/useLive";
import { Icon } from "../ui/Icon";
import { Ruler } from "../ui/Ruler";
import { Sheet } from "../ui/Sheet";
import { approx, fmt, tk } from "../ui/format";
import { toast } from "../ui/toast";

const TIERS: [Tier, string, string][] = [
  ["stable", "Постійний", "Профіль і закріплені факти: кешований префікс, читається дешево"],
  ["relevant", "Релевантний", "Знайдено за текстом задачі"],
  ["operative", "Оперативний", "Передається напряму, без пошуку"],
];

interface Props {
  agent: AgentManifest;
  resolved: Resolved | null;
  onRun: () => void;
}

export function ContextScreen({ agent, resolved, onRun }: Props) {
  const s = useSession();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [lib, setLib] = useState(false);
  const [libQ, setLibQ] = useState("");
  const artifacts = useLive(() => db.artifacts.orderBy("updatedAt").reverse().toArray(), [], []);

  if (!resolved) return <p className="note">Збираю контекст…</p>;

  const est = estimateRun(agent, resolved, s.task);
  const { packet, budget } = resolved;
  const stableTokens = resolved.parts.filter((p) => p.on && !p.dropped && p.tier === "stable").reduce((a, p) => a + p.tokens, 0);
  const customized = Object.keys(s.toggles).length > 0 || s.extraArtifactIds.length > 0;

  const toggle = (p: ResolvedPart) => setSession((st) => ({ toggles: { ...st.toggles, [p.id]: !p.on } }));
  const removeExtra = (p: ResolvedPart) =>
    setSession((st) => {
      const id = p.id.replace("extra:", "");
      const { [p.id]: _drop, ...rest } = st.toggles;
      return { extraArtifactIds: st.extraArtifactIds.filter((x) => x !== id), toggles: rest };
    });

  const libList = artifacts
    .filter((a) => !s.extraArtifactIds.includes(a.id))
    .filter((a) => !libQ.trim() || (a.title + " " + a.summary).toLowerCase().includes(libQ.trim().toLowerCase()));

  return (
    <>
      <section className="card pad">
        <div className="sumtop">
          <span className="big tnum">
            ≈{tk(packet.tokenEstimate)} <small>токенів з {tk(budget)}</small>
          </span>
          <span className="cost tnum">{approx(est.costUsd)}</span>
        </div>
        <Ruler value={packet.tokenEstimate} max={budget} label="Токени контексту" />
        <p className="note">
          Рівень моделі: {agent.model}. З кешу читається ≈{tk(stableTokens)} токенів стабільної частини, вони дешевші приблизно в 10 разів. Вартість це лише вхід, без відповіді.
        </p>
      </section>

      {!s.task.trim() && <p className="note">Релевантні джерела підбираються за текстом задачі. Введіть задачу на екрані «Робота».</p>}
      {packet.warnings?.map((w) => (
        <div key={w} className="warn">
          <Icon name="alert" size={18} />
          <span>{w}</span>
        </div>
      ))}

      {TIERS.map(([tier, name, cap]) => {
        const rows = resolved.parts.filter((p) => p.tier === tier);
        if (!rows.length) return null;
        return (
          <section key={tier} className="group">
            <h3>{name}</h3>
            <p>{cap}</p>
            {rows.map((p) => (
              <div key={p.id} className={"src" + (p.on ? "" : " off")}>
                <div className="rowm">
                  <button className="sw" role="switch" aria-checked={p.on} onClick={() => toggle(p)} aria-label={(p.on ? "Вимкнути: " : "Увімкнути: ") + p.title} />
                  <button className="expand" aria-expanded={!!open[p.id]} onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}>
                    <span className="t">
                      <span className="nm">{p.title}</span>
                      <span className="dt">
                        {p.dropped ? "не вмістилось у бюджет" : p.shrunk ? `скорочено · ${p.detail}` : p.detail}
                      </span>
                    </span>
                    <span className="tkn tnum">{fmt(p.on && !p.dropped ? p.tokens : p.fullTokens)}</span>
                    <span className={"chev" + (open[p.id] ? " open" : "")}>
                      <Icon name="right" size={16} />
                    </span>
                  </button>
                </div>
                {open[p.id] && (
                  <>
                    <pre className="prev">{p.on && !p.dropped ? p.text : renderPart(p, p.items)}</pre>
                    {p.manual && (
                      <button className="btn rm" onClick={() => removeExtra(p)}>
                        <Icon name="x" size={18} />
                        Прибрати з контексту
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </section>
        );
      })}

      <div className="acts nopad">
        <button className="btn" onClick={() => setLib(true)}>
          <Icon name="plus" size={18} />
          Додати з бібліотеки
        </button>
        {customized && (
          <button className="btn" onClick={() => setSession({ toggles: {}, extraArtifactIds: [] })}>
            Скинути вибір
          </button>
        )}
      </div>

      <button className="btn primary cta" onClick={onRun}>
        <Icon name="play" size={18} />
        Запустити з цим контекстом
      </button>

      <Sheet open={lib} title="Додати з бібліотеки" onClose={() => setLib(false)}>
        <input className="field" value={libQ} onChange={(e) => setLibQ(e.target.value)} placeholder="Пошук по бібліотеці" aria-label="Пошук по бібліотеці" />
        {libList.length === 0 ? (
          <p className="note">{artifacts.length ? "Нічого не знайдено." : "Бібліотека порожня. Збережіть відповідь агента кнопкою «Зберегти»."}</p>
        ) : (
          libList.map((a) => (
            <button
              key={a.id}
              className="lib"
              onClick={() => {
                setSession((st) => ({ extraArtifactIds: [...st.extraArtifactIds, a.id] }));
                setLib(false);
                toast(`Додано до контексту: ${a.title}`);
              }}
            >
              <span className="t">
                <span className="nm">{a.title}</span>
                <span className="dt">{a.summary.slice(0, 80)}</span>
              </span>
              <span className="tkn tnum">≈{tk(Math.ceil(a.content.length / 3.5))}</span>
            </button>
          ))
        )}
        <button className="btn wide" onClick={() => setLib(false)}>
          Закрити
        </button>
      </Sheet>
    </>
  );
}
