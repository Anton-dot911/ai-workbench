import { useState } from "react";
import { useLive } from "../db/useLive";
import { listPackages, savePackage } from "../engineering/store";
import { validatePackage, transition, revise, traceability, renderDocuments, type EngineeringPackage } from "../engineering/package";
import { toast } from "../ui/toast";

const statusLabel: Record<string, string> = { DRAFT: "Чернетка", REVIEW: "На перегляді", APPROVED: "Затверджено", IN_IMPLEMENTATION: "В реалізації", CHANGE_REQUESTED: "Потрібні зміни", COMPLETED: "Завершено", ARCHIVED: "Архів" };

export function PackageScreen() {
  // Усі екрани змонтовані одночасно, тож список має сам оновлюватись, коли агент створює чи змінює пакет (liveQuery Dexie).
  const packages = useLive<EngineeringPackage[]>(() => listPackages(), [], []);
  const [selected, setSelected] = useState<string>("");
  const [doc, setDoc] = useState<keyof ReturnType<typeof renderDocuments>>("REQUIREMENTS.md");
  const [busy, setBusy] = useState(false);
  // Якщо нічого не вибрано (або вибраний зник), показуємо найновіший пакет.
  const current = packages.some((p) => p.packageId === selected) ? selected : (packages[0]?.packageId ?? "");
  const pkg = packages.find((p) => p.packageId === current);
  const issues = pkg ? validatePackage(pkg, { complete: pkg.status === "DRAFT" || pkg.status === "REVIEW" }) : [];
  const docs = pkg ? renderDocuments(pkg) : {};
  const trace = pkg ? traceability(pkg) : [];
  async function act(fn: (p: EngineeringPackage) => EngineeringPackage, note: string) {
    if (!pkg) return;
    setBusy(true);
    try { await savePackage(fn(pkg)); toast(note); }
    catch (e) { toast(e instanceof Error ? e.message : "Операція не виконана"); }
    finally { setBusy(false); }
  }
  return <div className="screen package-screen">
    {packages.length === 0 ? <div className="card"><h3>Пакетів ще немає</h3><p>Запустіть рецепт «Пакет специфікацій» у режимі Авто, щоб створити перший пакет.</p></div> : <>
      <label className="field-label">Пакет</label>
      <select value={current} onChange={(e) => setSelected(e.target.value)}>{packages.map((p) => <option key={p.packageId} value={p.packageId}>{p.projectId} · v{p.version} · {statusLabel[p.status]}</option>)}</select>
      {pkg && <><div className="card"><h2>{pkg.projectId} · v{pkg.version}</h2><p>{statusLabel[pkg.status]}</p><p>{pkg.summary || "Без опису"}</p><p>{pkg.requirements.length} вимог · {pkg.components.length} компонентів · {pkg.dataModel.length} сутностей · {pkg.tasks.length} задач</p>
      <div className="actions">
      {pkg.status === "DRAFT" && <button disabled={busy} onClick={() => act((p) => transition(p,"REVIEW",{by:"user",note:"Передано на перегляд"}),"Пакет передано на перегляд")}>На перегляд</button>}
      {pkg.status === "REVIEW" && <><button disabled={busy} onClick={() => act((p) => transition(p,"APPROVED",{by:"user",note:"Затверджено"}),"Пакет затверджено")}>Затвердити</button><button disabled={busy} onClick={() => act((p) => transition(p,"DRAFT",{by:"user",note:"Повернуто в чернетку"}),"Повернуто в чернетку")}>Повернути</button></>}
      {pkg.status !== "DRAFT" && <button disabled={busy} onClick={() => act((p) => revise(p,{note:"Нова версія"}),"Створено нову версію")}>Нова версія</button>}
      </div></div>
      <div className="card"><h3>Перевірка пакета</h3><p>Помилки: {issues.filter(i=>i.severity==="error").length} · Попередження: {issues.filter(i=>i.severity==="warning").length}</p>{issues.length ? issues.map((i,n)=><div key={n} className="issue"><b>{i.severity==="error"?"Помилка":"Попередження"} · {i.code} · {i.path}</b><p>{i.message}</p></div>) : <p>За поточними правилами перевірки проблем не виявлено.</p>}</div>
      <div className="card"><h3>Документи</h3><select value={doc} onChange={(e)=>setDoc(e.target.value as typeof doc)}>{Object.keys(docs).map(k=><option key={k}>{k as any}</option>)}</select><pre className="package-doc">{docs[doc] ?? ""}</pre></div>
      <div className="card"><h3>Трасування вимог</h3>{trace.map((t)=><div className="trace" key={t.requirement}><b>{t.requirement} · {t.title}</b><p>Компоненти: {t.components.join(", ") || "—"}</p><p>Задачі: {t.tasks.join(", ") || "—"}</p><p>Перевірка: {t.verification.join(", ") || "—"}</p></div>)}</div>
      </>}
    </>}
  </div>;
}
