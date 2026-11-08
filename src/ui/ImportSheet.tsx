import { useState } from "react";
import { describeBundle, importBundle, parseBundle } from "../db/importexport";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { toast } from "./toast";

/** Імпорт пакета: файл експорту або вставлений текст. Лише додає, нічого не видаляє. */
export function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} title="Імпорт бази" onClose={onClose}>
      <ImportBody onClose={onClose} />
    </Sheet>
  );
}

function ImportBody({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = text.trim() ? parseBundle(text) : null;

  async function run() {
    if (!parsed?.ok || busy) return;
    setBusy(true);
    try {
      const s = await importBundle(parsed.bundle);
      const done = [s.profile ? "профіль" : "", s.memory ? `фактів ${s.memory}` : "", s.artifacts ? `артефактів ${s.artifacts}` : "", s.runs ? `запусків ${s.runs}` : ""].filter(Boolean).join(", ");
      toast(`Імпортовано: ${done || "нічого нового"}${s.skipped ? ` · пропущено ${s.skipped}` : ""}`);
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не вдалося імпортувати");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="note first">Вставте вміст файлу експорту або готовий пакет. Імпорт лише додає: наявні записи й однакові факти пропускаються, профіль доповнюється заповненими полями.</p>
      <label className="btn filebtn">
        <Icon name="down" size={18} />
        Вибрати файл
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
          }}
        />
      </label>
      <textarea className="field gap" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="або вставте JSON сюди" aria-label="Пакет для імпорту" spellCheck={false} autoCapitalize="off" />
      {parsed &&
        (parsed.ok ? (
          <p className="note tnum">Знайдено: {describeBundle(parsed.bundle)}</p>
        ) : (
          <div className="warn">{parsed.error}</div>
        ))}
      <div className="acts nopad">
        <button className="btn primary" disabled={!parsed?.ok || busy} onClick={run}>
          Імпортувати
        </button>
        <button className="btn" onClick={onClose}>
          Скасувати
        </button>
      </div>
    </>
  );
}
