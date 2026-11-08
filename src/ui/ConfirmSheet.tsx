import { useState } from "react";
import type { ConfirmDecision, ConfirmRequest } from "../tools/types";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** Diff правок: кожну можна прийняти або зняти. Закриття шторки = відхилити все. */
export function ConfirmSheet({ req, onDecision }: { req: ConfirmRequest | null; onDecision: (d: ConfirmDecision) => void }) {
  return (
    <Sheet open={req !== null} title={req?.title ?? ""} onClose={() => onDecision({ approve: false })}>
      {req && <ConfirmBody req={req} onDecision={onDecision} />}
    </Sheet>
  );
}

function ConfirmBody({ req, onDecision }: { req: ConfirmRequest; onDecision: (d: ConfirmDecision) => void }) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(req.edits.filter((e) => e.ok).map((e) => e.index)));
  const toggle = (i: number) =>
    setPicked((p) => {
      const n = new Set(p);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  return (
    <>
      {req.subtitle && <p className="note first">{req.subtitle}</p>}
      <div className="edits">
        {req.edits.map((e) => (
          <label key={e.index} className={"edit" + (e.ok ? "" : " bad")}>
            <input type="checkbox" checked={picked.has(e.index)} disabled={!e.ok} onChange={() => toggle(e.index)} aria-label={`Прийняти правку ${e.index + 1}`} />
            <span className="ebody">
              <span className="dt">
                {e.kind === "insert" ? "Вставка після" : "Заміна"} · правка {e.index + 1}
              </span>
              {e.kind === "insert" ? <span className="anchor">{e.before}</span> : <del>{e.before}</del>}
              <ins>{e.after || "(видалити)"}</ins>
              {e.reason && <span className="dt">{e.reason}</span>}
              {!e.ok && <span className="err">не застосується: {e.error}</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="acts nopad">
        <button className="btn primary" disabled={picked.size === 0} onClick={() => onDecision({ approve: true, accepted: [...picked] })}>
          <Icon name="check" size={18} />
          Застосувати ({picked.size})
        </button>
        <button className="btn" onClick={() => onDecision({ approve: false })}>
          Відхилити все
        </button>
      </div>
    </>
  );
}
