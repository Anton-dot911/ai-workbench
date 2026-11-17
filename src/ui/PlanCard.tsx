import { money } from "./format";

export type PlanState = "pending" | "running" | "cancelled" | "started";

export interface PlanView {
  summary: string;
  confidence: number;
  /** Уточнювальне питання замість плану. */
  clarify?: string;
  steps: { agentName: string; instruction: string }[];
  /** Назва рецепта, якщо план це готовий ланцюг. */
  recipe?: string;
  estimateUsd: number;
  routerUsd: number;
  limitUsd: number;
  lowConfidence: boolean;
  state: PlanState;
}

const SHORT = 180;

/** План від роутера: показується завжди перед запуском; нічого не виконується, доки не натиснуто «Запустити». */
export function PlanCard({ plan, onRun, onCancel }: { plan: PlanView; onRun: () => void; onCancel: () => void }) {
  const pending = plan.state === "pending";
  return (
    <section className="card plan" aria-label="План роутера">
      <div className="chead">
        <strong>{plan.clarify ? "Потрібне уточнення" : "План"}</strong>
        <span className={"conf" + (plan.lowConfidence ? " low" : "")}>впевненість {plan.confidence.toFixed(2).replace(".", ",")}</span>
      </div>
      {plan.summary && <p className="psum">{plan.summary}</p>}
      {plan.clarify ? (
        <p className="askq">{plan.clarify}</p>
      ) : (
        <>
          {plan.lowConfidence && <p className="warn">Роутер не певен, що правильно зрозумів задачу. Перевірте кроки або уточніть задачу.</p>}
          <ol className="psteps">
            {plan.steps.map((s, i) => (
              <li key={i}>
                <strong>{s.agentName}</strong>
                <span>{s.instruction.length > SHORT ? s.instruction.slice(0, SHORT) + "…" : s.instruction}</span>
              </li>
            ))}
          </ol>
          {plan.recipe && <p className="note">Рецепт «{plan.recipe}»: якщо перевірка знайде проблеми, пост один раз виправиться й перевіриться знову.</p>}
          <p className="note tnum">
            Оцінка до {money(plan.estimateUsd)} · ліміт ланцюга {money(plan.limitUsd)} · роутер {money(plan.routerUsd)}
          </p>
        </>
      )}
      {pending ? (
        <div className="acts nopad">
          {!plan.clarify && (
            <button className="btn primary" onClick={onRun}>
              {plan.lowConfidence ? "Запустити все одно" : "Запустити"}
            </button>
          )}
          <button className="btn" onClick={onCancel}>
            {plan.clarify ? "Уточнити задачу" : "Скасувати й змінити"}
          </button>
        </div>
      ) : (
        <p className="note">{plan.state === "cancelled" ? "Скасовано: задачу повернуто в поле вводу." : plan.state === "running" ? "Виконується…" : "Запущено."}</p>
      )}
    </section>
  );
}
