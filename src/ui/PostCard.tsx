import { useState } from "react";
import type { PostsOutput } from "../agents/outputs";
import { checkVariant, PLATFORMS } from "../agents/platforms";
import { Icon } from "./Icon";
import { Ruler } from "./Ruler";
import { fmt } from "./format";

export interface PostCardProps {
  data: PostsOutput;
  saved: number[];
  onSave: (variant: number) => void;
  onReview: (variant: number) => void;
  onCopy: (variant: number) => void;
  onReuse: (variant: number) => void;
  onAgain: () => void;
}

/** Варіанти поста з лінійкою довжини. Підрахунок і правила платформи рахує код (checkVariant), а не модель. */
export function PostCard({ data, saved, onSave, onReview, onCopy, onReuse, onAgain }: PostCardProps) {
  const [i, setI] = useState(0);
  const idx = Math.min(i, data.variants.length - 1);
  const v = data.variants[idx];
  const p = PLATFORMS[data.platform];
  const c = checkVariant(data.platform, v.text, v.hashtags);
  const hook = p.hookChars;
  const problems = [c.over ? `Перевищено ліміт на ${fmt(c.over)} симв.` : "", c.tagIssue ? `Хештеги: ${c.tagIssue}` : ""].filter(Boolean);

  return (
    <div>
      <div className="vt" role="tablist">
        <span className="pill">{p.name}</span>
        {data.variants.map((_, k) => (
          <button key={k} role="tab" aria-selected={k === idx} onClick={() => setI(k)}>
            Варіант {k + 1}
          </button>
        ))}
      </div>
      <div className="ptext">
        {hook ? (
          <>
            <span className="hook">{Array.from(v.text).slice(0, hook).join("")}</span>
            {Array.from(v.text).slice(hook).join("")}
          </>
        ) : (
          v.text
        )}
      </div>
      {v.hashtags.length > 0 && (
        <div className="tags">
          {v.hashtags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      )}
      <div className="gwrap">
        <Ruler value={c.count} max={c.max} label="Довжина поста" />
        <div className="gnum tnum">
          <span>
            {fmt(c.count)} / {fmt(c.max)} симв.
          </span>
          <span>{c.over ? `+${fmt(c.over)} понад ліміт` : "✓ у межах ліміту"}</span>
        </div>
      </div>
      <div className="pstatus">
        {problems.length ? problems.map((m) => <div key={m} className="warn">{m}</div>) : <div className="ok">✓ У межах правил {p.name}</div>}
        {hook && <p className="note">Підсвічено перші {hook} символів: стільки видно до кнопки «ще».</p>}
      </div>
      <div className="acts">
        <button className="btn" disabled={saved.includes(idx)} onClick={() => onSave(idx)}>
          <Icon name={saved.includes(idx) ? "check" : "save"} size={18} />
          {saved.includes(idx) ? "Збережено" : "Зберегти"}
        </button>
        <button className="btn" onClick={() => onReview(idx)}>
          <Icon name="review" size={18} />
          Перевірити
        </button>
        <button className="btn sq" aria-label="Копіювати" onClick={() => onCopy(idx)}>
          <Icon name="copy" size={18} />
        </button>
        <button className="btn sq" aria-label="Використати як фрагмент" onClick={() => onReuse(idx)}>
          <Icon name="reuse" size={18} />
        </button>
        <button className="btn sq" aria-label="Згенерувати знову" onClick={onAgain}>
          <Icon name="again" size={18} />
        </button>
      </div>
    </div>
  );
}
