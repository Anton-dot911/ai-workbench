import { useEffect, useRef, useState } from "react";
import { addMemory, db, getProfile, parseTags, saveProfile, updateMemory } from "../db/db";
import { useLive } from "../db/useLive";
import type { MemoryItem, Profile } from "../core/types";
import { FactForm } from "../ui/FactForm";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";
import { when } from "../ui/format";
import { toast } from "../ui/toast";

type ListKey = "expertise" | "brandWords" | "stack";
const listOf = (p: Profile, k: ListKey): string[] => (k === "stack" ? p.codingPrefs?.stack ?? [] : (p[k] as string[] | undefined) ?? []);

function ProfileCard({ initial }: { initial: Profile }) {
  const [p, setP] = useState<Profile>(initial);
  const [raw, setRaw] = useState<Record<ListKey, string>>({
    expertise: listOf(initial, "expertise").join(", "),
    brandWords: listOf(initial, "brandWords").join(", "),
    stack: listOf(initial, "stack").join(", "),
  });
  const saved = useRef(JSON.stringify(initial));

  async function commit(next: Profile) {
    setP(next);
    const json = JSON.stringify(next);
    if (json === saved.current) return;
    saved.current = json;
    await saveProfile(next);
    toast("Профіль збережено");
  }
  const lists = (): Profile => ({
    ...p,
    expertise: parseTags(raw.expertise),
    brandWords: parseTags(raw.brandWords),
    codingPrefs: { stack: parseTags(raw.stack), style: p.codingPrefs?.style ?? "" },
  });
  const blur = () => void commit(lists());
  const priv = new Set(p.privateFields ?? []);
  const togglePrivate = (key: string) => {
    const next = new Set(priv);
    next.has(key) ? next.delete(key) : next.add(key);
    void commit({ ...lists(), privateFields: [...next] });
  };

  const lock = (k: string) => (
    <button className="lockbtn" aria-pressed={priv.has(k)} onClick={() => togglePrivate(k)} aria-label={priv.has(k) ? "Не передається в запити. Натисніть, щоб передавати" : "Передається в запити. Натисніть, щоб приховати"}>
      <Icon name="lock" size={16} />
      {priv.has(k) ? "приховано" : "передається"}
    </button>
  );

  return (
    <section className="card pad">
      <label className="lbl">
        Ім'я
        <input className="field" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} onBlur={blur} autoComplete="off" />
      </label>
      <p className="note">Ім'я зберігається лише на пристрої й агентам не передається.</p>

      <div className="lblrow"><span>Мова</span>{lock("language")}</div>
      <input className="field" value={p.language} onChange={(e) => setP({ ...p, language: e.target.value })} onBlur={blur} autoCapitalize="off" />

      <div className="lblrow"><span>Тон</span>{lock("tone")}</div>
      <textarea className="field" rows={2} value={p.tone} onChange={(e) => setP({ ...p, tone: e.target.value })} onBlur={blur} placeholder="діловий, без канцеляризмів" />

      <div className="lblrow"><span>Аудиторія</span>{lock("audience")}</div>
      <input className="field" value={p.audience} onChange={(e) => setP({ ...p, audience: e.target.value })} onBlur={blur} placeholder="розробники, техліди" />

      <div className="lblrow"><span>Експертиза, через кому</span>{lock("expertise")}</div>
      <input className="field" value={raw.expertise} onChange={(e) => setRaw({ ...raw, expertise: e.target.value })} onBlur={blur} />

      <div className="lblrow"><span>Слова бренду, через кому</span>{lock("brandWords")}</div>
      <input className="field" value={raw.brandWords} onChange={(e) => setRaw({ ...raw, brandWords: e.target.value })} onBlur={blur} />

      <div className="lblrow"><span>Код: стек, через кому</span>{lock("codingPrefs")}</div>
      <input className="field" value={raw.stack} onChange={(e) => setRaw({ ...raw, stack: e.target.value })} onBlur={blur} placeholder="TypeScript, React, Vercel" />
      <input className="field gap" value={p.codingPrefs?.style ?? ""} onChange={(e) => setP({ ...p, codingPrefs: { stack: parseTags(raw.stack), style: e.target.value } })} onBlur={blur} placeholder="Стиль коду: стисло, без зайвих коментарів" />
    </section>
  );
}

export function MemoryScreen() {
  const profile = useLive(() => getProfile(), null as Profile | null);
  const facts = useLive(() => db.memory.toArray(), [] as MemoryItem[]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<MemoryItem | "new" | null>(null);
  // Форма профілю створюється один раз після завантаження, далі вона сама джерело правди.
  const [seed, setSeed] = useState<Profile | null>(null);
  useEffect(() => {
    if (profile && !seed) setSeed(profile);
  }, [profile, seed]);

  const needle = q.trim().toLowerCase();
  const shown = facts
    .filter((f) => !needle || f.text.toLowerCase().includes(needle) || f.tags.some((t) => t.includes(needle)))
    .sort((a, b) => (b.pinned ?? 0) - (a.pinned ?? 0) || b.createdAt - a.createdAt);
  const pinnedCount = facts.filter((f) => f.pinned === 1).length;

  return (
    <>
      <h2 className="sec first">Профіль</h2>
      {seed ? <ProfileCard initial={seed} /> : <p className="note">Завантаження…</p>}
      <p className="note">Профіль іде в кешований префікс кожного запиту. Замок «приховано» виключає поле з запитів.</p>

      <h2 className="sec">Факти · {facts.length}</h2>
      <p className="note first">
        Закріплених {pinnedCount}: вони передаються завжди. Решта підбираються за текстом задачі.
      </p>
      <div className="inrow bar">
        <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук по фактах" aria-label="Пошук по фактах" />
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" size={18} />
          Додати
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="note">{facts.length ? "Нічого не знайдено." : "Поки порожньо. Додайте факт про себе, проєкти чи стиль. Агенти використовуватимуть його в запитах."}</p>
      ) : (
        <div className="list">
          {shown.map((f) => (
            <div key={f.id} className="item fact">
              <p className="ftext">{f.text}</p>
              {f.tags.length > 0 && (
                <div className="chips">
                  {f.tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              )}
              <div className="frow">
                <span className="dt">
                  {when(f.createdAt)}
                  {f.source === "agent" ? " · з відповіді агента" : ""}
                </span>
                <span className="fbtns">
                  <button className="iconbtn" aria-pressed={f.pinned === 1} aria-label={f.pinned === 1 ? "Відкріпити" : "Закріпити"} onClick={() => updateMemory(f.id, { pinned: f.pinned === 1 ? 0 : 1 })}>
                    <Icon name="pin" size={20} />
                  </button>
                  <button className="iconbtn" aria-label="Редагувати" onClick={() => setEditing(f)}>
                    <Icon name="edit" size={20} />
                  </button>
                  <button
                    className="iconbtn"
                    aria-label="Видалити"
                    onClick={async () => {
                      if (confirm("Видалити цей факт? Дію не можна скасувати.")) await db.memory.delete(f.id);
                    }}
                  >
                    <Icon name="trash" size={20} />
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Sheet open={editing !== null} title={editing === "new" ? "Новий факт" : "Редагувати факт"} onClose={() => setEditing(null)}>
        <FactForm
          initial={editing && editing !== "new" ? { text: editing.text, tags: editing.tags, pinned: editing.pinned === 1 } : undefined}
          submitLabel="Зберегти"
          onCancel={() => setEditing(null)}
          onSubmit={async (v) => {
            if (editing === "new") await addMemory({ ...v, source: "user" });
            else if (editing) await updateMemory(editing.id, { text: v.text, tags: v.tags, pinned: v.pinned ? 1 : 0 });
            setEditing(null);
            toast("Факт збережено");
          }}
        />
      </Sheet>
    </>
  );
}
