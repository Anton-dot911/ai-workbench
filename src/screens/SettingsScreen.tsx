import { useEffect, useState } from "react";
import type { StatusResponse } from "../core/claude";
import { MODEL_MAP } from "../core/settings";
import { exportAll } from "../db/db";
import { ImportSheet } from "../ui/ImportSheet";
import { Icon } from "../ui/Icon";
import { Ruler } from "../ui/Ruler";
import { fmt, money } from "../ui/format";
import { toast } from "../ui/toast";

interface Props {
  status: StatusResponse | null;
  statusError: string;
  onRefresh: () => void;
  onLogout: () => void;
}

export function SettingsScreen({ status, statusError, onRefresh, onLogout }: Props) {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
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
