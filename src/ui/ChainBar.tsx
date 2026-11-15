import type { ChainStatus } from "../core/orchestrator";
import { Ruler } from "./Ruler";
import { money } from "./format";

export type StepState = "wait" | "run" | "done" | "stopped" | "error";

export interface ChainView {
  recipe: string;
  topic: string;
  steps: { agentId: string; name: string; state: StepState }[];
  status: "running" | ChainStatus | "error";
  costUsd: number;
  limitUsd: number;
}

const MARK: Record<StepState, string> = { wait: "○", run: "●", done: "✓", stopped: "■", error: "✕" };
const STATUS: Record<ChainView["status"], string> = {
  running: "Виконується…",
  done: "Готово",
  stopped_cost: "Зупинено: перевищено ліміт вартості",
  stopped_user: "Зупинено вами",
  stopped_steps: "Зупинено: ліміт кроків ланцюга",
  aborted: "Зупинено",
  error: "Помилка, ланцюг перервано",
};

/** Заголовок ланцюга: кроки зі станами й витрати проти ліміту. Результати кроків показуються нижче звичайними картками. */
export function ChainBar({ chain }: { chain: ChainView }) {
  return (
    <section className="card chain" aria-label="Ланцюг агентів">
      <div className="chead">
        <strong>{chain.recipe}</strong>
        <span className="note">{chain.topic}</span>
      </div>
      <ol className="csteps">
        {chain.steps.map((s, i) => (
          <li key={i} className={"cs " + s.state} aria-current={s.state === "run" ? "step" : undefined}>
            <span className="mk" aria-hidden="true">
              {MARK[s.state]}
            </span>
            {s.name}
          </li>
        ))}
      </ol>
      <div className="sumtop">
        <span className={"cstat " + chain.status}>{STATUS[chain.status]}</span>
        <span className="tnum">
          {money(chain.costUsd)} з {money(chain.limitUsd)}
        </span>
      </div>
      <Ruler value={chain.costUsd} max={chain.limitUsd} label="Витрати ланцюга" />
    </section>
  );
}
