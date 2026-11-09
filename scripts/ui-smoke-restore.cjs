// Димовий тест: локальна база очищена системою, а хмарна копія є → застосунок пропонує відновлення.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const proj = path.resolve(__dirname, "..");
const fdb = require("fake-indexeddb");
const { webcrypto } = require("crypto");

const dist = proj + "/dist";
const html = fs.readFileSync(dist + "/index.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
const bundle = fs.readFileSync(dist + "/assets/" + fs.readdirSync(dist + "/assets").find((f) => f.endsWith(".js")), "utf8");

const errors = [];
const dom = new JSDOM(html, { url: "https://app.test/", pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window;
Object.assign(w, { indexedDB: fdb.indexedDB, IDBKeyRange: fdb.IDBKeyRange, TextEncoder, TextDecoder, structuredClone, queueMicrotask });
Object.defineProperty(w, "crypto", { value: webcrypto, configurable: true });
w.addEventListener("error", (e) => errors.push("window.error: " + e.message));
w.console.error = (...a) => errors.push("console.error: " + a.map(String).join(" ").slice(0, 300));
w.localStorage.setItem("wb.token", "t");
// Токен і маркер першого запуску пережили очищення, а IndexedDB порожня.
w.localStorage.setItem("wb.firstSeen", String(Date.now() - 3 * 86400000));

const backup = {
  profile: [{ tone: "діловий, прямий", language: "uk" }],
  memory: [{ text: "Факт із копії один", pinned: true }, { text: "Факт із копії два" }],
  artifacts: [],
};
const counts = { profile: true, memory: 2, artifacts: 0 };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
w.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("/api/backup")) return u.includes("meta") ? json({ ok: true, savedAt: Date.now() - 3600000, counts }) : json({ ok: true, savedAt: Date.now() - 3600000, counts, data: backup });
  return json({ ok: true, spent: { dayUsd: 0, monthUsd: 0 }, limits: { dayUsd: 3, monthUsd: 30 }, prices: {}, tz: "Europe/Kyiv" });
};

const d = w.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => d.querySelector(s);
const qa = (s) => [...d.querySelectorAll(s)];
const byText = (sel, t) => qa(sel).find((e) => e.textContent.includes(t));
const check = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) process.exitCode = 1; };

(async () => {
  w.eval(bundle);
  await sleep(600);
  check("повідомлення про наявну хмарну копію", /є хмарна копія/.test(q(".toast").textContent), q(".toast").textContent);
  byText(".tab", "Пам'ять").click(); await sleep(80);
  const offer = q(".offer");
  check("банер відновлення: дата, кількість, причина", !!offer && /фактів 2/.test(offer.textContent) && /очистила система/.test(offer.textContent), offer?.textContent);
  check("список фактів порожній до відновлення", !byText(".fact .ftext", "Факт із копії"));
  byText(".offer button", "Відновити").click(); await sleep(600);
  check("після відновлення факти на місці", !!byText(".fact .ftext", "Факт із копії один") && !!byText(".fact .ftext", "Факт із копії два"));
  check("закріплений факт лишився закріпленим", q(".fact .iconbtn[aria-pressed=true]") !== null);
  check("банер зник", !q(".offer"));
  check("профіль відновлено", q("textarea[placeholder='діловий, без канцеляризмів']").value === "діловий, прямий");
  byText(".tab", "Параметри").click(); await sleep(250);
  const settings = q("section[aria-label=Налаштування]").textContent;
  check("параметри попереджають, що базу очищено системою", /Локальну базу було очищено/.test(settings));
  console.log("\nпомилки в консолі/вікні:", errors.length ? errors : "немає");
  if (errors.length) process.exitCode = 1;
  process.exit();
})().catch((e) => { console.error("СКРИПТ ВПАВ:", e); process.exit(2); });
