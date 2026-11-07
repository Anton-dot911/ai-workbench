import { useState } from "react";
import { parseTags } from "../db/db";

export interface FactValue {
  text: string;
  tags: string[];
  pinned: boolean;
}

export function FactForm({
  initial,
  submitLabel,
  hint,
  onSubmit,
  onCancel,
}: {
  initial?: FactValue;
  submitLabel: string;
  hint?: string;
  onSubmit: (v: FactValue) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit({ text: text.trim(), tags: parseTags(tags), pinned });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      {hint && <p className="note first">{hint}</p>}
      <label className="lbl">
        Факт
        <textarea
          className="field"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Коротко й самодостатньо: «Веду Telegram-канал про DevOps»"
        />
      </label>
      <label className="lbl">
        Теги, через кому
        <input className="field" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="канал, devops" autoCapitalize="off" />
      </label>
      <label className="check">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        <span>Закріпити: передавати агентам завжди</span>
      </label>
      <div className="acts nopad">
        <button className="btn primary" disabled={!text.trim() || busy} onClick={submit}>
          {submitLabel}
        </button>
        <button className="btn" onClick={onCancel}>
          Скасувати
        </button>
      </div>
    </div>
  );
}
