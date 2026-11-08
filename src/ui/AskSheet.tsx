import { useState } from "react";
import type { AskRequest } from "../tools/types";
import { Sheet } from "./Sheet";

/** Уточнювальне питання від агента (інструмент ask_user). Закриття шторки = порожня відповідь. */
export function AskSheet({ req, onAnswer }: { req: AskRequest | null; onAnswer: (a: string) => void }) {
  return (
    <Sheet open={req !== null} title="Питання від агента" onClose={() => onAnswer("")}>
      {req && <AskBody req={req} onAnswer={onAnswer} />}
    </Sheet>
  );
}

function AskBody({ req, onAnswer }: { req: AskRequest; onAnswer: (a: string) => void }) {
  const [text, setText] = useState("");
  return (
    <>
      <p className="askq">{req.question}</p>
      {req.options?.map((o) => (
        <button key={o} className="ex" onClick={() => onAnswer(o)}>
          {o}
        </button>
      ))}
      <textarea className="field gap" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ваша відповідь" aria-label="Ваша відповідь" />
      <button className="btn primary wide" disabled={!text.trim()} onClick={() => onAnswer(text.trim())}>
        Відповісти
      </button>
    </>
  );
}
