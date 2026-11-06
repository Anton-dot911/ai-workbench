import { useCallback, useEffect, useState } from "react";
import { docsAgent } from "./agents/docs";
import { ApiError, getStatus, type StatusResponse } from "./core/claude";
import { setPrices } from "./core/prices";
import { clearToken, getToken } from "./core/settings";
import { Gate } from "./screens/Gate";
import { LibraryScreen } from "./screens/LibraryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { WorkScreen } from "./screens/WorkScreen";
import { Icon, type IconName } from "./ui/Icon";
import { Toaster } from "./ui/toast";

type Tab = "work" | "library" | "settings";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "work", label: "Робота", icon: "tWork" },
  { id: "library", label: "Бібліотека", icon: "tLib" },
  { id: "settings", label: "Налаштування", icon: "tSet" },
];

const HEAD: Record<Tab, { title: string; sub: string }> = {
  work: { title: docsAgent.name, sub: docsAgent.subtitle },
  library: { title: "Бібліотека", sub: "Збережені результати й журнал запусків" },
  settings: { title: "Налаштування", sub: "Витрати, дані, доступ" },
};

export default function App() {
  const [token, setTokenState] = useState(getToken());
  const [tab, setTab] = useState<Tab>("work");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState("");

  const logout = useCallback(() => {
    clearToken();
    setTokenState("");
    setStatus(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const s = await getStatus(token);
      setPrices(s.prices);
      setStatus(s);
      setStatusError("");
    } catch (e) {
      if (e instanceof ApiError && e.kind === "auth") logout();
      else setStatusError(e instanceof Error ? e.message : "Не вдалося отримати стан витрат.");
    }
  }, [token, logout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Просимо браузер не чистити IndexedDB автоматично (див. «Надійність локальних даних» у специфікації).
  useEffect(() => {
    if (token) void navigator.storage?.persist?.();
  }, [token]);

  if (!token) return <Gate onToken={setTokenState} />;

  const head = HEAD[tab];
  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>{head.title}</h1>
          <p>{head.sub}</p>
        </div>
        {tab === "work" && <span className="pill">{docsAgent.model}</span>}
      </header>

      <main>
        <section className={"screen work-host" + (tab === "work" ? " on" : "")} aria-label="Робота">
          <WorkScreen token={token} onAuthError={logout} onSpent={refresh} />
        </section>
        <section className={"screen" + (tab === "library" ? " on" : "")} aria-label="Бібліотека">
          <LibraryScreen />
        </section>
        <section className={"screen" + (tab === "settings" ? " on" : "")} aria-label="Налаштування">
          <SettingsScreen status={status} statusError={statusError} onRefresh={refresh} onLogout={logout} />
        </section>
      </main>

      <nav className="tabs" aria-label="Розділи">
        {TABS.map((t) => (
          <button key={t.id} className="tab" aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} />
            {t.label}
          </button>
        ))}
      </nav>
      <Toaster />
    </div>
  );
}
