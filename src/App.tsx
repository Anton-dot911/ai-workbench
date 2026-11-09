import { useCallback, useEffect, useState } from "react";
import { getAgent } from "./agents/registry";
import { ApiError, getStatus, type StatusResponse } from "./core/claude";
import { resolveContext, type Resolved } from "./core/contextBuilder";
import { setPrices } from "./core/prices";
import { sessionTask, setSession, useSession } from "./core/session";
import { clearToken, getToken } from "./core/settings";
import { backupMeta, isAutoBackup, pushBackup, restoreBackup, type BackupMeta } from "./db/backup";
import { useDataVersion } from "./db/changes";
import { checkHealth, dataCounts, isLocalEmpty, type StorageHealth } from "./db/health";
import { ContextScreen } from "./screens/ContextScreen";
import { Gate } from "./screens/Gate";
import { LibraryScreen } from "./screens/LibraryScreen";
import { MemoryScreen } from "./screens/MemoryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { WorkScreen } from "./screens/WorkScreen";
import { AgentSheet } from "./ui/AgentSheet";
import { Icon, type IconName } from "./ui/Icon";
import { Toaster, toast } from "./ui/toast";

type Tab = "work" | "ctx" | "library" | "memory" | "settings";

// Підпис «Параметри» замість «Налаштування»: п'ять вкладок на 375 pt не вміщують довге слово.
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "work", label: "Робота", icon: "tWork" },
  { id: "ctx", label: "Контекст", icon: "tCtx" },
  { id: "library", label: "Бібліотека", icon: "tLib" },
  { id: "memory", label: "Пам'ять", icon: "tMem" },
  { id: "settings", label: "Параметри", icon: "tSet" },
];

const staticHead = (name: string, sub: string): Record<Tab, { title: string; sub: string }> => ({
  work: { title: name, sub },
  ctx: { title: "Контекст запуску", sub: `Що отримає «${name}»` },
  library: { title: "Бібліотека", sub: "Збережені результати й журнал запусків" },
  memory: { title: "Пам'ять", sub: "Профіль і факти для всіх агентів" },
  settings: { title: "Налаштування", sub: "Витрати, дані, доступ" },
});

export default function App() {
  const [token, setTokenState] = useState(getToken());
  const [tab, setTab] = useState<Tab>("work");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [health, setHealth] = useState<StorageHealth | null>(null);
  const [offer, setOffer] = useState<BackupMeta | null>(null);
  const [offerDismissed, setOfferDismissed] = useState(false);
  const session = useSession();
  const agent = getAgent(session.agentId);
  const dataVersion = useDataVersion();

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

  // Просимо браузер не чистити IndexedDB автоматично.
  useEffect(() => {
    if (token) void navigator.storage?.persist?.();
  }, [token]);

  // Діагностика сховища: чи було воно очищене системою.
  useEffect(() => {
    if (token) checkHealth().then(setHealth).catch((e) => console.error(e));
  }, [token]);

  // Якщо локальна база порожня, а хмарна копія є, пропонуємо відновити.
  useEffect(() => {
    if (!token) return;
    let dead = false;
    (async () => {
      try {
        if (!isLocalEmpty(await dataCounts())) return void (!dead && setOffer(null));
        const m = await backupMeta(token);
        if (!dead) setOffer(m);
      } catch {
        /* без мережі чи без Redis: не заважаємо */
      }
    })();
    return () => {
      dead = true;
    };
  }, [token, dataVersion]);
  useEffect(() => {
    if (offer && !offerDismissed) toast("Локальна база порожня, але є хмарна копія. Відкрийте «Пам'ять».");
  }, [offer, offerDismissed]);

  // Автокопія (якщо ввімкнена): через кілька секунд після змін. Порожній стан не відправляється.
  useEffect(() => {
    if (!token || !isAutoBackup()) return;
    const t = setTimeout(() => void pushBackup(token).catch(() => {}), 8000);
    return () => clearTimeout(t);
  }, [token, dataVersion]);

  async function restoreFromOffer() {
    try {
      const s = await restoreBackup(token);
      toast(`Відновлено: фактів ${s.memory}, артефактів ${s.artifacts}${s.profile ? ", профіль" : ""}`);
      setOffer(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не вдалося відновити");
    }
  }

  // Попередній перегляд контексту: перераховується, коли змінюються задача, фрагмент, перемикачі чи дані.
  useEffect(() => {
    if (!token) return;
    let dead = false;
    const t = setTimeout(() => {
      resolveContext(agent, sessionTask(session))
        .then((r) => !dead && setResolved(r))
        .catch((e) => console.error(e));
    }, 250);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [token, agent, session.task, session.frag, session.turns, session.toggles, session.extraArtifactIds, dataVersion]);

  if (!token) return <Gate onToken={setTokenState} />;

  const head = staticHead(agent.name, agent.subtitle)[tab];
  const screen = (id: Tab) => "screen" + (tab === id ? " on" : "");
  return (
    <div className="app">
      <header className="top">
        <div>
          {tab === "work" ? (
            <button className="agentbtn" onClick={() => setAgentOpen(true)} aria-label={`Агент: ${agent.name}. Змінити`}>
              <h1>{head.title}</h1>
              <Icon name="chevd" size={22} />
            </button>
          ) : (
            <h1>{head.title}</h1>
          )}
          <p>{head.sub}</p>
        </div>
        {(tab === "work" || tab === "ctx") && <span className="pill">{agent.model}</span>}
      </header>

      <main>
        <section className={screen("work") + " work-host"} aria-label="Робота">
          <WorkScreen token={token} resolved={resolved} onAuthError={logout} onSpent={refresh} onOpenContext={() => setTab("ctx")} />
        </section>
        <section className={screen("ctx")} aria-label="Контекст">
          <ContextScreen
            agent={agent}
            resolved={resolved}
            onRun={() => {
              if (!session.task.trim()) {
                toast("Введіть задачу на екрані «Робота»");
                setTab("work");
                return;
              }
              setTab("work");
              setSession((s) => ({ runNonce: s.runNonce + 1 }));
            }}
          />
        </section>
        <section className={screen("library")} aria-label="Бібліотека">
          <LibraryScreen />
        </section>
        <section className={screen("memory")} aria-label="Пам'ять">
          <MemoryScreen offer={offerDismissed ? null : offer} health={health} onRestore={restoreFromOffer} onDismissOffer={() => setOfferDismissed(true)} />
        </section>
        <section className={screen("settings")} aria-label="Налаштування">
          <SettingsScreen token={token} health={health} status={status} statusError={statusError} onRefresh={refresh} onLogout={logout} />
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
      <AgentSheet
        open={agentOpen}
        current={agent.id}
        onClose={() => setAgentOpen(false)}
        onPick={(id) => {
          setSession({ agentId: id });
          setAgentOpen(false);
          toast(`Агент: ${getAgent(id).name}`);
        }}
      />
      <div id="sheet-root" />
      <Toaster />
    </div>
  );
}
