import { useState } from "react";
import { describeBundle, importBundle, parseBundle } from "../db/importexport";
import { db, saveTextArtifact } from "../db/db";
import { extractPdfText } from "../db/documentImport";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { toast } from "./toast";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
type DocumentPreview = { name: string; format: string; content: string; pages?: number };

/** Імпорт JSON-пакетів або текстових документів у бібліотеку. */
export function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} title="Імпорт бази та документів" onClose={onClose}>
      <ImportBody onClose={onClose} />
    </Sheet>
  );
}

function ImportBody({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [doc, setDoc] = useState<DocumentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = text.trim() ? parseBundle(text) : null;

  async function selectFile(file?: File) {
    if (!file) return;
    setDoc(null);
    setText("");
    if (file.size > MAX_FILE_BYTES) {
      toast("Файл завеликий. Максимальний розмір — 10 МБ.");
      return;
    }
    const ext = file.name.split(".").pop()?.toLowerCase();
    try {
      if (ext === "json" || file.type === "application/json") {
        setText(await file.text());
      } else if (ext === "md" || ext === "txt" || ext === "pdf") {
        let content = "";
        let pages: number | undefined;
        if (ext === "pdf") {
          const result = await extractPdfText(file);
          content = result.text;
          pages = result.pages;
          if (!content.trim()) throw new Error("PDF не містить доступного тексту. Можливо, це скан — OCR поки не підтримується.");
        } else {
          content = await file.text();
        }
        if (!content.trim()) throw new Error("Файл порожній.");
        setDoc({ name: file.name, format: ext.toUpperCase(), content, pages });
      } else {
        toast("Підтримуються файли JSON, MD, TXT та PDF.");
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "Не вдалося прочитати файл");
    }
  }

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      if (doc) {
        const title = doc.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Документ";
        const normalized = doc.content.replace(/\s+/g, " ").trim().toLowerCase();
        const existing = await db.artifacts.toArray();
        if (existing.some((a) => a.type === "document" && a.title.toLowerCase() === title.toLowerCase() && a.content.replace(/\s+/g, " ").trim().toLowerCase() === normalized)) {
          toast("Такий документ уже є в бібліотеці.");
          onClose();
          return;
        }
        await saveTextArtifact(doc.content, "document", { title, fallbackTitle: title });
        toast(`Документ імпортовано: ${title}`);
        onClose();
        return;
      }
      if (!parsed?.ok) return;
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
      <p className="note first">JSON відновлює/додає дані бази. MD, TXT і PDF додаються до Бібліотеки як документи. Імпорт не видаляє наявні записи.</p>
      <label className="btn filebtn">
        <Icon name="down" size={18} />
        Вибрати файл (JSON · MD · TXT · PDF)
        <input type="file" accept=".json,application/json,.md,text/markdown,.txt,text/plain,.pdf,application/pdf" onChange={(e) => { void selectFile(e.target.files?.[0]); e.currentTarget.value = ""; }} />
      </label>
      {!doc && <textarea className="field gap" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="або вставте JSON сюди" aria-label="Пакет для імпорту" spellCheck={false} autoCapitalize="off" />}
      {doc && (
        <div className="card gap">
          <p className="note"><strong>{doc.name}</strong> · {doc.format}{doc.pages ? ` · ${doc.pages} стор.` : ""} · {doc.content.length.toLocaleString()} символів</p>
          <div className="ptext" style={{ maxHeight: "240px", overflow: "auto", whiteSpace: "pre-wrap" }}>{doc.content.slice(0, 5000)}{doc.content.length > 5000 ? "\n… (попередній перегляд обрізано)" : ""}</div>
        </div>
      )}
      {parsed && !doc && (parsed.ok ? <p className="note tnum">Знайдено: {describeBundle(parsed.bundle)}</p> : <div className="warn">{parsed.error}</div>)}
      <div className="acts nopad">
        <button className="btn primary" disabled={busy || (!doc && !parsed?.ok)} onClick={() => void run()}>Імпортувати</button>
        <button className="btn" onClick={onClose}>Скасувати</button>
      </div>
    </>
  );
}
