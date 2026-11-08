// Димовий тест інтерфейсу: зібраний бандл у jsdom з імітацією IndexedDB і API. Запускати після `vite build`.
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
const origErr = w.console.error;
w.console.error = (...a) => { errors.push("console.error: " + a.map(String).join(" ").slice(0, 300)); };
w.localStorage.setItem("wb.token", "t");

const posts = [];
const PRICES = { "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 } };
const sse = (evs) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
let nextTool = null;
const textTurn = () => sse([
  { type: "message_start", message: { usage: { input_tokens: 500, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Готовий текст відповіді" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
]);
const toolTurn = (t) => {
  const json = JSON.stringify(t.input);
  return sse([
    { type: "message_start", message: { usage: { input_tokens: 300, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Виправляю." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_ui", name: t.name, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 12) } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(12) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
  ]);
};
w.fetch = async (url, init = {}) => {
  if (init.method === "POST") {
    const body = JSON.parse(init.body);
    posts.push(body);
    const last = body.messages.at(-1);
    const isResult = Array.isArray(last.content) && last.content[0]?.type === "tool_result";
    let payload = textTurn();
    if (nextTool && !isResult) { payload = toolTurn(nextTool); nextTool = null; }
    return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(JSON.stringify({ ok: true, spent: { dayUsd: 0.5, monthUsd: 2 }, limits: { dayUsd: 3, monthUsd: 30 }, prices: PRICES, tz: "Europe/Kyiv" }), { status: 200, headers: { "content-type": "application/json" } });
};

const d = w.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => d.querySelector(s);
const qa = (s) => [...d.querySelectorAll(s)];
const byText = (sel, t) => qa(sel).find((e) => e.textContent.includes(t));
const setVal = (el, v) => {
  const proto = el.tagName === "TEXTAREA" ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
};
const tab = async (label) => { byText(".tab", label).click(); await sleep(60); };
const check = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) process.exitCode = 1; };

(async () => {
  w.eval(bundle);
  await sleep(400);
  check("5 вкладок", qa(".tab").length === 5, qa(".tab").map((t) => t.textContent).join(" | "));
  check("початковий екран «Документи»", q(".top h1").textContent === "Документи");

  // Пам'ять: додати закріплений факт
  await tab("Пам'ять");
  check("екран «Пам'ять»", q(".top h1").textContent === "Пам'ять");
  [...q("section[aria-label=\"Пам'ять\"]").querySelectorAll("button")].find((b) => b.textContent.includes("Додати")).click(); await sleep(60);
  check("шторка нового факту відкрита", !!q(".sheet.on"));
  setVal(q(".sheet.on textarea"), "Веду Telegram-канал про DevOps");
  setVal(q(".sheet.on input[placeholder]"), "канал, devops");
  q(".sheet.on input[type=checkbox]").click(); await sleep(30);
  byText(".sheet.on button", "Зберегти").click(); await sleep(250);
  check("факт з'явився у списку", !!byText(".fact .ftext", "DevOps"));
  check("факт закріплений", q(".fact .iconbtn[aria-pressed=true]") !== null);

  // Профіль: тон + приватне поле
  const tone = q("textarea[placeholder='діловий, без канцеляризмів']");
  setVal(tone, "діловий, без канцеляризмів");
  tone.dispatchEvent(new w.Event("focusout", { bubbles: true })); tone.blur?.();
  tone.dispatchEvent(new w.FocusEvent("blur", { bubbles: false })); await sleep(250);

  // Робота → задача → чип контексту
  await tab("Робота");
  setVal(q(".inrow input[type=text]"), "Напиши пост про Telegram канал"); await sleep(450);
  const chip = q(".chip").textContent;
  check("чип контексту показує джерела й токени", /\d+ джерел[оа]? · ≈\d+/.test(chip), chip);

  // Контекст
  await tab("Контекст");
  check("екран «Контекст»", q(".top h1").textContent === "Контекст запуску");
  const titles = qa(".src .nm").map((e) => e.textContent);
  check("є закріплені факти й профіль", titles.some((t) => t.startsWith("Закріплені факти")) && titles.includes("Профіль"), titles.join("; "));
  check("історія вимкнена, коли її немає — не показується", !titles.some((t) => t.startsWith("Історія")));
  const before = q(".big").textContent;
  const profSw = qa(".sw").find((s) => s.getAttribute("aria-label").includes("Профіль"));
  profSw.click(); await sleep(450);
  check("вимкнення профілю зменшує токени", q(".big").textContent !== before, before + " → " + q(".big").textContent);
  profSw.click(); await sleep(450);
  byText(".expand", "Закріплені").click(); await sleep(50);
  check("розгортання показує XML-вміст", /<facts>[\s\S]*DevOps/.test(q(".prev").textContent));

  // Запуск з панелі контексту
  byText("button", "Запустити з цим контекстом").click(); await sleep(900);
  check("запит пішов на /api/claude", posts.length === 1);
  const req = posts[0];
  check("запит: модель із MODEL_MAP, префікс кешується", req.model === "claude-sonnet-5-5" && req.system[0].cache_control?.type === "ephemeral");
  check("запит: закріплений факт у системному префіксі", /<facts>[\s\S]*DevOps/.test(req.system[0].text));
  check("запит: задача у <task>", JSON.stringify(req.messages).includes("<task>"));
  check("відповідь показана на екрані «Робота»", q(".top h1").textContent === "Документи" && !!byText(".ptext", "Готовий текст відповіді"));
  check("під відповіддю токени й джерела", /вхід 500 · вихід 20/.test(q(".card .note.mx.tnum")?.textContent ?? ""), q(".card .note.mx.tnum")?.textContent);

  // Запам'ятати
  byText(".card .btn", "Запам'ятати").click(); await sleep(80);
  check("шторка «Запам'ятати» відкрита й підставлено відповідь", q(".sheet.on textarea")?.value.includes("Готовий текст"));
  byText(".sheet.on button", "Запам'ятати").click(); await sleep(250);
  await tab("Пам'ять");
  check("факт з відповіді агента збережено", !!byText(".fact", "Готовий текст") && !!byText(".fact", "з відповіді агента"));

  // Бібліотека: зберегти й додати в контекст
  await tab("Робота");
  byText(".card .btn", "Зберегти").click(); await sleep(250);
  await tab("Бібліотека");
  check("артефакт у бібліотеці", qa(".item").length >= 1);
  byText(".itemhead", "Готовий").click(); await sleep(60);
  byText(".item .btn", "В контекст").click(); await sleep(450);
  await tab("Контекст");
  check("артефакт доданий вручну в контекст", qa(".src .dt").some((e) => e.textContent.includes("додано вручну")));

  // Агенти, команди, правки з diff (етап 3a)
  await tab("Робота");
  const taskInput = () => q(".inrow input[type=text]");
  q(".agentbtn").click(); await sleep(80);
  check("шторка агентів: список і команди", !!q(".sheet.on .agent") && /Документи/.test(q(".sheet.on").textContent) && /\/док/.test(q(".sheet.on").textContent));
  qa(".scrim.on")[0].click(); await sleep(80);
  check("шторка закривається по тапу на фон", !q(".sheet.on"));

  const before3 = posts.length;
  setVal(taskInput(), "/xyz тест"); await sleep(30); q(".go").click(); await sleep(80);
  check("невідома команда: підказка, запиту немає", /Невідома команда/.test(q(".toast").textContent) && posts.length === before3, q(".toast").textContent);
  setVal(taskInput(), "/док"); await sleep(30); q(".go").click(); await sleep(80);
  check("команда без тексту перемикає агента", /Агент: Документи/.test(q(".toast").textContent) && posts.length === before3);

  q(".clipbtn").click(); await sleep(50);
  setVal(q("textarea.frag"), "У рамках проєкту. Даний документ описує план.");
  nextTool = { name: "apply_edits", input: { target: "selection", edits: [
    { find: "У рамках", replace: "У межах", reason: "калька" },
    { find: "Даний документ", replace: "Документ", reason: "канцелярит" },
  ] } };
  setVal(taskInput(), "виправ калькі"); await sleep(60); q(".go").click(); await sleep(900);
  check("diff-шторка: заголовок і дві правки", /Підтвердьте зміни/.test(q(".sheet.on")?.textContent ?? "") && qa(".sheet.on .edit").length === 2);
  check("diff показує що замінюється й на що", !!q(".sheet.on .edit del") && !!q(".sheet.on .edit ins"));
  qa(".sheet.on .edit input")[1].click(); await sleep(50);
  const applyBtn = byText(".sheet.on button", "Застосувати (1)");
  check("лічильник правок оновився після зняття галочки", !!applyBtn);
  applyBtn.click(); await sleep(1000);
  check("прийнято лише першу правку", q("textarea.frag").value === "У межах проєкту. Даний документ описує план.", q("textarea.frag").value);
  check("запит із tool_result пішов у модель", posts.at(-1).messages.at(-1).content[0].type === "tool_result" && /Застосовано правок: 1 з 2/.test(posts.at(-1).messages.at(-1).content[0].content));
  check("у картці є мітка інструмента й підсумок", qa(".tool.ok").some((e) => e.textContent.includes("правки")) && !!byText(".ptext", "Виправляю."));
  check("шторка закрилась, запуск завершено", !q(".sheet.on") && !q(".go.stop"));

  // Налаштування
  await tab("Параметри");
  check("витрати з проксі на екрані параметрів", /\$0,50 з \$3,00/.test(q("#s-settings, section[aria-label=Налаштування]").textContent));

  console.log("\nпомилки в консолі/вікні:", errors.length ? errors : "немає");
  if (errors.length) process.exitCode = 1;
  process.exit();
})().catch((e) => { console.error("СКРИПТ ВПАВ:", e); process.exit(2); });
