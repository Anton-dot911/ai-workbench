import { Sheet } from "./Sheet";

export interface GateRequest {
  title: string;
  text: string;
  yes: string;
  no: string;
}

/** Підтвердження посеред ланцюга (перевищення ліміту вартості, точка зупинки). Закриття шторки = відмова. */
export function GateSheet({ req, onDecision }: { req: GateRequest | null; onDecision: (ok: boolean) => void }) {
  return (
    <Sheet open={req !== null} title={req?.title ?? "Підтвердження"} onClose={() => onDecision(false)}>
      {req && (
        <>
          <p className="askq">{req.text}</p>
          <div className="acts nopad">
            <button className="btn primary" onClick={() => onDecision(true)}>
              {req.yes}
            </button>
            <button className="btn" onClick={() => onDecision(false)}>
              {req.no}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
