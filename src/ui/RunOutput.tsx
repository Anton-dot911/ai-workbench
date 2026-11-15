import { parsePosts, parseReview } from "../agents/outputs";
import { checkVariant } from "../agents/platforms";
import { ReviewCard } from "./ReviewCard";
import { fmt } from "./format";

/** Вихід запуску в журналі: варіанти постів і результат перевірки читабельно, решта текстом. Лише для читання. */
export function RunOutput({ agentId, output }: { agentId: string; output: string }) {
  const posts = agentId === "posts" ? parsePosts(output) : null;
  if (posts) {
    return (
      <div className="pv">
        {posts.variants.map((v, k) => {
          const c = checkVariant(posts.platform, v.text, v.hashtags);
          return (
            <div key={k}>
              <p className="note mx tnum">
                Варіант {k + 1} · {fmt(c.count)} / {fmt(c.max)} симв.
                {c.over ? ` · +${fmt(c.over)} понад ліміт` : ""}
              </p>
              <div className="ptext">{v.text}</div>
              {v.hashtags.length > 0 && (
                <div className="tags">
                  {v.hashtags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }
  const review = agentId === "review" ? parseReview(output) : null;
  if (review) return <ReviewCard data={review} />;
  return <div className="ptext">{output}</div>;
}
