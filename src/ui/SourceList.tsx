import { sourceHost } from "../core/citations";

/** Джерела відповіді. Посилання відкриваються в новій вкладці; небезпечні схеми (не http/https) не стають посиланнями. */
export function SourceList({ sources }: { sources: { url: string; title: string }[] }) {
  if (!sources.length) return null;
  return (
    <div className="srcs">
      <span className="dt">Джерела · {sources.length}</span>
      <ol>
        {sources.map((s) => (
          <li key={s.url}>
            {/^https?:\/\//i.test(s.url) ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title}
              </a>
            ) : (
              <span>{s.title}</span>
            )}
            <span className="dt">{sourceHost(s.url)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
