import type { ReviewIssue, ReviewOutput } from "../agents/outputs";
import { Icon } from "./Icon";

const SEV: Record<ReviewIssue["severity"], string> = { high: "висока", medium: "середня", low: "низька" };
const CAT: Record<ReviewIssue["category"], string> = { language: "мова", facts: "факти", logic: "логіка", style: "стиль", code: "код", brief: "завдання" };
const ORDER: Record<ReviewIssue["severity"], number> = { high: 0, medium: 1, low: 2 };

/** Результат «Перевірки»: вердикт, оцінка, зауваження; зауваження з готовою заміною можна застосувати з diff. */
export function ReviewCard({ data, onApply }: { data: ReviewOutput; onApply: (issues: ReviewIssue[]) => void }) {
  const issues = [...data.issues].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const fixable = issues.filter((i) => i.replacement !== undefined);
  return (
    <div className="rv">
      <div className="rvh">
        <strong className={data.verdict === "ok" ? "okc" : "badc"}>{data.verdict === "ok" ? "Зауважень немає" : "Потрібні правки"}</strong>
        <span className="tkn tnum">оцінка {data.score} / 10</span>
      </div>
      <p className="note">{data.summary}</p>
      {issues.map((i, n) => (
        <div key={n} className={"iss " + i.severity}>
          <span className="meta">
            {SEV[i.severity]} · {CAT[i.category]}
          </span>
          {i.quote && <q>{i.quote}</q>}
          <p>{i.problem}</p>
          <p className="sugg">{i.suggestion}</p>
          {i.replacement !== undefined && (
            <p className="repl">
              <span className="meta">Заміна</span> <ins>{i.replacement || "(видалити)"}</ins>
            </p>
          )}
          {i.source && <p className="meta">Джерело: {i.source}</p>}
        </div>
      ))}
      {fixable.length > 0 && (
        <div className="acts nopad">
          <button className="btn primary" onClick={() => onApply(fixable)}>
            <Icon name="check" size={18} />
            Застосувати виправлення ({fixable.length})
          </button>
        </div>
      )}
      {fixable.length > 0 && <p className="note">Зміни застосовуються до тексту у «Фрагменті». Перед цим ви побачите diff.</p>}
    </div>
  );
}
