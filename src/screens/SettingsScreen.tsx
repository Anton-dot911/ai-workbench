import { useEffect, useState } from "react";
import type { StatusResponse } from "../core/claude";
import { backupMeta, isAutoBackup, lastBackupLocal, pushBackup, restoreBackup, setAutoBackup, type BackupMeta } from "../db/backup";
import { MODEL_MAP } from "../core/settings";
import { exportAll } from "../db/db";
import { dataCounts, selfTest, type DataCounts, type SelfTest, type StorageHealth } from "../db/health";
import { ImportSheet } from "../ui/ImportSheet";
import { Icon } from "../ui/Icon";
import { Ruler } from "../ui/Ruler";
import { fmt, money, when } from "../ui/format";
import { toast } from "../ui/toast";

interface Props {
  token: string;
  health: StorageHealth | null;
  status: StatusResponse | null;
  statusError: string;
  onRefresh: () => void;
  onLogout: () => void;
}

export function SettingsScreen({ token, health, status, statusError, onRefresh, onLogout }: Props) {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [meta, setMeta] = useState<BackupMeta | null | undefined>(undefined);
  const [metaError, setMetaError] = useState("");
  const [auto, setAuto] = useState(isAutoBackup());
  const [counts, setCounts] = useState<DataCounts | null>(null);
  const [test, setTest] = useState<SelfTest | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshMeta = async () => {
    try {
      setMeta(await backupMeta(token));
      setMetaError("");
    } catch (e) {
      setMetaError(e instanceof Error ? e.message : "Не вдалося отримати стан копії");
    }
  };
  useEffect(() => {
    void refreshMeta();
    void dataCounts().then(setCounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function saveNow() {
    setBusy(true);
    try {
      const r = await pushBackup(token, { force: true });
      toast(r.skipped === "empty" ? "Локальна база порожня: копію не збережено, щоб не затерти наявну" : "Копію збережено");
      await refreshMeta();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не вдалося зберегти копію");
    } finally {
      setBusy(false);
    }
  }
  async function restoreNow() {
    setBusy(true);
    try {
      const s = await restoreBackup(token);
      const done = [s.profile ? "профіль" : "", s.memory ? `фактів ${s.memory}` : "", s.artifacts ? `артефактів ${s.artifacts}` : ""].filter(Boolean).join(", ");
      toast(`Відновлено: ${done || "нічого нового"}`);
      setCounts(await dataCounts());
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не вдалося відновити");
    } finally {
      setBusy(false);
    }
  }
  async function toggleAuto(on: boolean) {
    setAuto(on);
    setAutoBackup(on);
    if (on) await saveNow();
  }
  const lastErr = lastBackupLocal()?.error;
  const standalone = (navigator as { standalone?: boolean }).standalone === true || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);

  const readStorage = async () => {
    try {
      setPersisted((await navigator.storage?.persisted?.()) ?? null);
      const e = await navigator.storage?.estimate?.();
      if (e?.usage !== undefined && e.quota !== undefined) setUsage({ used: e.usage, quota: e.quota });
    } catch {
      setPersisted(null);
    }
  };
  useEffect(() => {
    void readStorage();
  }, []);

  async function askPersist() {
    const ok = (await navigator.storage?.persist?.()) ?? false;
    toast(ok ? "Сховище захищене від автоочищення" : "Браузер не дав захист. Робіть експорт регулярно.");
    void readStorage();
  }

  async function doExport() {
    const json = JSON.stringify(await exportAll(), null, 2);
    const name = `workbench-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: "application/json" });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <h2 className="sec first">Витрати</h2>
      <section className="card pad">
        {status ? (
          <>
            <div className="sumtop">
              <span className="nm">Сьогодні</span>
              <span className="tnum">
                {money(status.spent.dayUsd)} з {money(status.limits.dayUsd)}
              </span>
            </div>
            <Ruler value={status.spent.dayUsd} max={status.limits.dayUsd} label="Витрати за день" />
            <div className="sumtop gap">
              <span className="nm">Цей місяць</span>
              <span className="tnum">
                {money(status.spent.monthUsd)} з {money(status.limits.monthUsd)}
              </span>
            </div>
            <Ruler value={status.spent.monthUsd} max={status.limits.monthUsd} label="Витрати за місяць" />
            <p className="note">Лічильник веде проксі, день і місяць рахуються за часовим поясом {status.tz}.</p>
          </>
        ) : (
          <p className="note">{statusError || "Завантаження…"}</p>
        )}
        <button className="btn" onClick={onRefresh}>
          Оновити
        </button>
      </section>

      <h2 className="sec">Дані</h2>
      <section className="card pad">
        <p className="note first">
          Усе зберігається в IndexedDB цього браузера на цьому пристрої.{" "}
          {persisted === true && "Сховище захищене від автоочищення."}
          {persisted === false && "Сховище може бути очищене браузером, якщо бракуватиме місця."}
        </p>
        <p className="note">
          Зараз: {standalone ? "встановлений застосунок" : "вкладка браузера"} · {location.host}
        </p>
        <p className="note">
          На iPhone вкладка Safari й іконка на початковому екрані мають окремі сховища: дані з одного не видно в іншому. Так само для кожної адреси
          (у кожного деплою Vercel вона може бути своя). Користуйтеся одним способом входу або переносіть дані через експорт та імпорт.
          {!standalone && " У вкладці Safari сайт може втратити дані після кількох днів без відвідувань, тому краще встановити застосунок."}
        </p>
        {usage && (
          <p className="note tnum">
            Зайнято {fmt(usage.used / 1024)} КБ із {fmt(usage.quota / 1024 / 1024)} МБ
          </p>
        )}
        <div className="acts nopad">
          {persisted === false && (
            <button className="btn" onClick={askPersist}>
              Захистити сховище
            </button>
          )}
          <button className="btn" onClick={doExport}>
            <Icon name="down" size={18} />
            Експортувати базу
          </button>
          <button className="btn" onClick={() => setImportOpen(true)}>
            <Icon name="plus" size={18} />
            Імпортувати
          </button>
        </div>
      </section>

      <h2 className="sec">Хмарна копія</h2>
      <section className="card pad">
        <p className="note first">
          Профіль, факти й артефакти можна зберігати у вашому Redis (Upstash) через проксі, під вашим токеном. Журнал запусків не копіюється. Якщо локальну базу буде очищено, застосунок запропонує відновити копію.
        </p>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => void toggleAuto(e.target.checked)} />
          <span>Автоматична копія після змін</span>
        </label>
        <p className="note tnum">
          {metaError
            ? metaError
            : meta === undefined
              ? "Перевіряю копію…"
              : meta === null
                ? "Копії ще немає."
                : `Остання копія: ${when(meta.savedAt)} · фактів ${meta.counts.memory}, артефактів ${meta.counts.artifacts}${meta.counts.profile ? ", профіль" : ""}`}
        </p>
        {lastErr && <div className="warn">Остання спроба копії не вдалась: {lastErr}</div>}
        <div className="acts nopad">
          <button className="btn" disabled={busy} onClick={saveNow}>
            Зберегти копію зараз
          </button>
          <button className="btn" disabled={busy} onClick={restoreNow}>
            Відновити з копії
          </button>
        </div>
      </section>

      <h2 className="sec">Стан сховища</h2>
      <section className="card pad">
        {health && (
          <p className="note first tnum">
            Сховище створено: {when(health.firstSeen)}
            {health.fresh ? " (щойно)" : ""}
          </p>
        )}
        {health?.idbWiped && (
          <div className="warn">
            Локальну базу було очищено, хоча застосунок запускався тут раніше ({when(health.firstSeen)}). Відновіть дані з копії або імпортуйте файл.
          </div>
        )}
        {health?.lsCleared && <div className="warn">Очищено налаштування браузера (localStorage), база даних збереглась.</div>}
        {counts && (
          <p className="note tnum">
            У базі: профіль {counts.profile ? "заповнено" : "порожній"}, фактів {counts.memory}, артефактів {counts.artifacts}, запусків {counts.runs}
          </p>
        )}
        <button
          className="btn"
          onClick={async () => {
            setTest(await selfTest());
            setCounts(await dataCounts());
          }}
        >
          Перевірити запис у сховище
        </button>
        {test && (test.ok ? <p className="ok">✓ Запис і читання працюють ({test.ms} мс)</p> : <div className="warn">Запис у сховище не працює: {test.error}</div>)}
      </section>

      <h2 className="sec">Моделі</h2>
      <section className="card pad">
        {(Object.entries(MODEL_MAP) as [string, string][]).map(([tier, id]) => (
          <div key={tier} className="sumtop">
            <span className="nm">{tier}</span>
            <span className="tnum dt">{id}</span>
          </div>
        ))}
        <p className="note">Мапа задається в src/core/settings.ts. Ціни приходять із проксі.</p>
      </section>

      <h2 className="sec">Доступ</h2>
      <section className="card pad">
        <p className="note first">Токен збережено на цьому пристрої. Ключ Anthropic у браузер не потрапляє.</p>
        <button className="btn" onClick={onLogout}>
          Вийти
        </button>
      </section>
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
