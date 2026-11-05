import { useState } from "react";
import { ApiError, getStatus } from "../core/claude";
import { setPrices } from "../core/prices";
import { setToken } from "../core/settings";

export function Gate({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true);
    setError("");
    try {
      const s = await getStatus(t);
      setPrices(s.prices);
      setToken(t);
      onToken(t);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не вдалося перевірити токен.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Воркбенч</h1>
          <p>Персональний AI-воркбенч</p>
        </div>
      </header>
      <main>
        <div className="screen on">
          <div className="card pad">
            <h2 className="sec first">Вхід</h2>
            <p className="note">Введіть токен доступу (змінна APP_TOKEN у Vercel). Він зберігається лише на цьому пристрої.</p>
            <input
              className="field"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Токен доступу"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              aria-label="Токен доступу"
            />
            {error && <div className="warn">{error}</div>}
            <button className="btn primary wide" onClick={submit} disabled={busy || !value.trim()}>
              {busy ? "Перевіряю…" : "Увійти"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
