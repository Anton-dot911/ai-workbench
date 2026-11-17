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
const backups = { latest: null };
const searchStep = () => sse([
  { type: "message_start", message: { usage: { input_tokens: 800, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query": "web push ios"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://webkit.org/blog/1", title: "WebKit", encrypted_content: "ENC", page_age: "2026" }] } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 60, server_tool_use: { web_search_requests: 1 } } },
]);
const answerStep = () => sse([
  { type: "message_start", message: { usage: { input_tokens: 1500, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Web Push працює на iOS 16.4+" } },
  { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://webkit.org/blog/1", title: "WebKit", encrypted_index: "e", cited_text: "…" } } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " лише для PWA." } },
  { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://developer.apple.com/docs", title: "Apple Docs", encrypted_index: "e2", cited_text: "…" } } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 120, server_tool_use: { web_search_requests: 1 } } },
]);
let seq = [];
w.fetch = async (url, init = {}) => {
  if (String(url).startsWith("/api/backup")) {
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (init.method === "POST") {
      const b = JSON.parse(init.body);
      backups.latest = { savedAt: Date.now(), counts: { profile: !!b.profile?.[0]?.tone, memory: b.memory.length, artifacts: b.artifacts.length }, data: b };
      return json({ ok: true, savedAt: backups.latest.savedAt, counts: backups.latest.counts });
    }
    if (!backups.latest) return json({ error: { type: "not_found", message: "Копії ще немає." } }, 404);
    const { savedAt, counts, data } = backups.latest;
    return json(String(url).includes("meta") ? { ok: true, savedAt, counts } : { ok: true, savedAt, counts, data });
  }
  if (init.method === "POST") {
    const body = JSON.parse(init.body);
    posts.push(body);
    const last = body.messages.at(-1);
    const isResult = Array.isArray(last.content) && last.content[0]?.type === "tool_result";
    let payload = textTurn();
    if (seq.length) payload = seq.shift()();
    if (!seq.length && nextTool && !isResult) { payload = toolTurn(nextTool); nextTool = null; }
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

  // Етап 3b: «Перевірка» → виправлення з diff; «Пости» → варіанти, лінійка, збереження, передача в перевірку
  await tab("Робота");
  const lastCard = () => [...q("section[aria-label=\"Робота\"]").querySelectorAll("section.card")].at(-1);
  const inCard = (t) => [...lastCard().querySelectorAll("button")].find((b) => b.textContent.includes(t));
  setVal(q("textarea.frag"), "Текст у рамках проєкту та даний документ."); await sleep(40);
  nextTool = { name: "submit_review", input: { verdict: "needs_changes", score: 6, summary: "Є калька і канцелярит", issues: [
    { severity: "low", category: "style", quote: "даний документ", problem: "канцелярит", suggestion: "цей документ" },
    { severity: "medium", category: "language", quote: "у рамках", problem: "калька", suggestion: "у межах", replacement: "у межах" },
  ] } };
  setVal(taskInput(), "/перевір language"); await sleep(60); q(".go").click(); await sleep(900);
  check("агент перемкнувся на «Перевірку» командою", q(".agentbtn h1").textContent === "Перевірка");
  check("запит має tool_choice auto і лише завершальний інструмент (обов'язковість перевіряє runAgent)", posts.at(-1).tool_choice?.type === "auto" && posts.at(-1).tools.some((t) => t.name === "submit_review") && posts.at(-1).tools.every((t) => t.name === "submit_review" || t.name === "handoff") && !("temperature" in posts.at(-1)), JSON.stringify(posts.at(-1).tool_choice));
  check("картка перевірки: вердикт, оцінка, зауваження", /Потрібні правки/.test(lastCard().textContent) && /оцінка 6 \/ 10/.test(lastCard().textContent) && qa(".iss").length >= 2);
  check("серйозніше зауваження першим", qa(".iss")[0].classList.contains("medium"));
  const fixBtn = inCard("Застосувати виправлення (1)");
  check("кнопка виправлень рахує лише зауваження з готовою заміною", !!fixBtn);
  fixBtn.click(); await sleep(300);
  check("виправлення відкривають diff-шторку", /Підтвердьте зміни/.test(q(".sheet.on")?.textContent ?? "") && qa(".sheet.on .edit").length === 1);
  byText(".sheet.on button", "Застосувати (1)").click(); await sleep(500);
  check("виправлення застосовано до фрагмента", q("textarea.frag").value === "Текст у межах проєкту та даний документ.", q("textarea.frag").value);

  nextTool = { name: "submit_posts", input: { platform: "linkedin", variants: [
    { text: "Перший варіант поста про PWA і офлайн.", hashtags: ["PWA", "offline", "webdev"] },
    { text: "Другий варіант: що працює без мережі.", hashtags: ["PWA", "offline", "webdev"] },
  ] } };
  setVal(taskInput(), "/пост linkedin: PWA"); await sleep(60); q(".go").click(); await sleep(900);
  check("агент «Пости»: картка з варіантами", q(".agentbtn h1").textContent === "Пости" && lastCard().querySelectorAll(".vt button").length === 2);
  check("лінійка й лічильник за правилами LinkedIn", /\/ 3\s000 симв\./.test(lastCard().textContent) && !!lastCard().querySelector(".gauge") && /У межах правил LinkedIn/.test(lastCard().textContent));
  check("хештеги показані окремо й нормалізовані", [...lastCard().querySelectorAll(".tags span")].map((e) => e.textContent).join(",") === "#PWA,#offline,#webdev");
  [...lastCard().querySelectorAll(".vt button")][1].click(); await sleep(60);
  check("перемикання на варіант 2", /Другий варіант/.test(lastCard().querySelector(".ptext").textContent));
  inCard("Зберегти").click(); await sleep(300);
  check("варіант збережено як пост", /Збережено в бібліотеці як пост/.test(q(".toast").textContent) && !!inCard("Збережено"));
  inCard("Перевірити").click(); await sleep(150);
  check("«Перевірити» передає варіант у агента «Перевірка»", q(".agentbtn h1").textContent === "Перевірка" && /Другий варіант/.test(q("textarea.frag").value) && /#PWA/.test(q("textarea.frag").value));
  await tab("Бібліотека");
  check("у бібліотеці є артефакт-пост", qa(".itemhead .nm").some((e) => /Другий варіант/.test(e.textContent)));
  await tab("Робота");
  setVal(taskInput(), ""); await sleep(30);

  // Етап 3c: «Пошук» (веб-пошук, пауза, цитати, джерела), пропозиції пам'яті, збереження звіту
  await tab("Робота");
  const feedCards = () => [...q("section[aria-label=\"Робота\"]").querySelectorAll("section.card")];
  const before3c = posts.length;
  seq = [searchStep, () => toolTurn({ name: "propose_memory", input: { text: "Користувач досліджує Web Push для своєї PWA", tags: ["pwa"], reason: "пряма тема запиту" } }), answerStep];
  setVal(taskInput(), "/пошук Web Push на iOS"); await sleep(60); q(".go").click(); await sleep(1500);
  check("агент «Пошук» вибрано командою", q(".agentbtn h1").textContent === "Пошук");
  const firstReq = posts[before3c];
  const wsTool = firstReq.tools.find((t) => t.type === "web_search_20250305");
  check("запит містить веб-пошук з max_uses 10 і клієнтські інструменти", wsTool?.max_uses === 10 && firstReq.tools.some((t) => t.name === "propose_memory"), JSON.stringify(wsTool));
  check("після паузи запит завершується повідомленням асистента без tool_result", posts[before3c + 1].messages.at(-1).role === "assistant" && posts[before3c + 1].messages.at(-1).content.some((b) => b.type === "web_search_tool_result" && b.content[0].encrypted_content === "ENC"));
  check("за пропозицією пам'яті йде третій запит із tool_result", posts.length === before3c + 3 && posts[before3c + 2].messages.at(-1).content[0].type === "tool_result");
  const searchCard = feedCards().at(-1);
  check("мітки: веб-пошук із запитом і пропозиція пам'яті", /веб-пошук: web push ios/.test(searchCard.textContent) && /пропозиція пам'яті/.test(searchCard.textContent), searchCard.querySelector(".toolrow")?.textContent);
  check("відповідь із маркерами цитат", /Web Push працює на iOS 16\.4\+ \[1\] лише для PWA\. \[2\]/.test(searchCard.querySelector(".ptext").textContent), searchCard.querySelector(".ptext").textContent);
  const links = [...searchCard.querySelectorAll(".srcs a")];
  check("джерела: два посилання, відкриваються в новій вкладці безпечно", links.length === 2 && links[0].href === "https://webkit.org/blog/1" && links[0].rel.includes("noopener") && links[0].target === "_blank");
  check("у підсумку вартості видно кількість пошуків", /пошуків 2/.test(searchCard.textContent), searchCard.querySelector(".note.mx.tnum")?.textContent);
  check("тост про запропонований факт", /запропонував фактів: 1/.test(q(".toast").textContent), q(".toast").textContent);
  check("на вкладці «Пам'ять» є лічильник пропозицій", q("#t-memory .badge")?.textContent === "1" || [...qa(".tab")].find((t) => t.textContent.includes("Пам'ять"))?.querySelector(".badge")?.textContent === "1");
  [...searchCard.querySelectorAll("button")].find((b) => b.textContent.includes("Зберегти")).click(); await sleep(300);
  await tab("Бібліотека");
  check("звіт збережено в бібліотеці як «Пошук: …» із джерелами", qa(".itemhead .nm").some((e) => /Пошук: Web Push на iOS/.test(e.textContent)));
  byText(".itemhead", "Пошук: Web Push").click(); await sleep(60);
  check("у збереженому звіті є список джерел", qa(".item .srcs a").length === 2);
  await tab("Пам'ять");
  check("черга: пропозиція з позначкою «З веб-джерел»", /На підтвердження · 1/.test(q("section[aria-label=\"Пам'ять\"]").textContent) && !!q(".prop.web .webwarn"));
  check("пропозиція ще не є фактом", !byText(".fact:not(.prop) .ftext", "досліджує Web Push"));
  byText(".prop button", "Прийняти").click(); await sleep(400);
  check("після прийняття факт у пам'яті, черга порожня, лічильника немає", !!byText(".fact:not(.prop) .ftext", "досліджує Web Push") && !q(".prop") && ![...qa(".tab")].find((t) => t.textContent.includes("Пам'ять")).querySelector(".badge"));

  // відхилення: той самий факт повторно не пропонується
  await tab("Робота");
  nextTool = { name: "propose_memory", input: { text: "Другий кандидат у факти про проєкт", tags: [] } };
  setVal(taskInput(), "/док нотатка про проєкт"); await sleep(60); q(".go").click(); await sleep(900);
  await tab("Пам'ять");
  check("друга пропозиція від агента без веб-позначки", !!q(".prop") && !q(".prop.web"));
  byText(".prop button", "Відхилити").click(); await sleep(300);
  check("відхилена пропозиція зникла з черги й не стала фактом", !q(".prop") && !byText(".fact .ftext", "Другий кандидат"));
  await tab("Робота");
  nextTool = { name: "propose_memory", input: { text: "Другий кандидат у факти про проєкт", tags: [] } };
  setVal(taskInput(), "/док ще раз"); await sleep(60); q(".go").click(); await sleep(900);
  check("повторна пропозиція відхиленого блокується (tool_result з помилкою)", /відхилив/.test(JSON.stringify(posts.at(-1).messages.at(-1).content)));

  // Етап 4: рецепт «Пост з дослідженням» (Пошук → Пости → Перевірка), ліміт вартості ланцюга
  await tab("Робота");
  const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; };
  const chains = () => qa("section.chain");
  const chainSeq = () => [
    searchStep,
    answerStep,
    () => toolTurn({ name: "submit_posts", input: { platform: "x", variants: [
      { text: "Web Push на iOS працює лише для PWA з початкового екрана.", hashtags: ["PWA", "iOS"] },
      { text: "iOS 16.4+: Web Push тільки для встановлених PWA.", hashtags: ["PWA"] },
    ] } }),
    () => toolTurn({ name: "submit_review", input: { verdict: "ok", score: 9, summary: "Факти збігаються зі звітом пошуку", issues: [] } }),
  ];
  const runChainCmd = async (text) => { setVal(taskInput(), text); await sleep(60); q(".go").click(); };

  const c0 = chains().length;
  await runChainCmd("/пост-з-пошуком X:"); await sleep(150);
  check("рецепт без теми: підказка, ланцюг не стартував", /Вкажіть тему/.test(q(".toast")?.textContent ?? "") && chains().length === c0);
  setVal(taskInput(), "/пост-з-пошуком"); await sleep(40); q(".go").click(); await sleep(150);
  check("рецепт без аргументів: підказка з прикладом і заготовка команди", /Пост з дослідженням/.test(q(".toast").textContent) && taskInput().value === "/пост-з-пошуком ");
  setVal(taskInput(), ""); await sleep(30);

  const before4 = posts.length;
  seq = chainSeq();
  await runChainCmd("/пост-з-пошуком X: Background Sync у Safari");
  const finished = await waitFor(() => chains().length === c0 + 1 && /Готово/.test(chains().at(-1).textContent) && !q(".go.stop"), 8000);
  check("ланцюг завершився: смужка зі станом «Готово»", finished, chains().at(-1)?.textContent);
  const bar = chains().at(-1);
  const stepEls = [...bar.querySelectorAll(".csteps .cs")];
  check("смужка: Пошук, Пости, Перевірка, усі виконані", stepEls.map((e) => e.textContent.replace(/[✓●○■✕]/g, "")).join("|") === "Пошук|Пости|Перевірка" && stepEls.every((e) => e.classList.contains("done")), stepEls.map((e) => e.className + ":" + e.textContent).join(" | "));
  check("витрати ланцюга проти ліміту й лінійка", /(<\$0,01|\$0,\d\d) з \$0,25/.test(bar.textContent) && !!bar.querySelector(".gauge"), bar.textContent);
  check("чотири запити: пошук (з паузою), пости, перевірка", posts.length === before4 + 4, String(posts.length - before4));
  const uptext = (b) => b.messages[0].content.map((x) => x.text).join("\n");
  check("пошук запитує веб-пошук і не отримує upstream", !!posts[before4].tools.find((t) => t.type === "web_search_20250305") && !/<upstream>/.test(uptext(posts[before4])));
  check("«Пости» отримали звіт пошуку як недовірений вміст, платформа X", /<upstream>\s*<untrusted_content source="web-derived">[\s\S]*Web Push працює на iOS 16\.4\+/.test(uptext(posts[before4 + 2])) && /^<task>\nx: Background Sync у Safari/.test(posts[before4 + 2].messages[0].content.at(-1).text));
  check("«Перевірка» отримала пост і звіт, режими facts, language", /Текст для перевірки \(пост для x\)/.test(uptext(posts[before4 + 3])) && /Джерело тверджень/.test(uptext(posts[before4 + 3])) && /facts, language/.test(posts[before4 + 3].messages[0].content.at(-1).text));
  check("усі запити без temperature, а tool_choice лише auto", posts.slice(before4).every((b) => !("temperature" in b) && (!b.tool_choice || b.tool_choice.type === "auto")));
  const labels = qa("section[aria-label=\"Робота\"] p.note").map((e) => e.textContent);
  check("кроки підписані «Крок i з 3»", labels.some((t) => /Крок 1 з 3 · Пошук/.test(t)) && labels.some((t) => /Крок 2 з 3 · Пости/.test(t)) && labels.some((t) => /Крок 3 з 3 · Перевірка/.test(t)), labels.filter((t) => /Крок/.test(t)).join(" | "));
  const stepCards = feedCards().slice(-3);
  check("крок 1: звіт із джерелами й кнопками збереження", stepCards[0].querySelectorAll(".srcs a").length === 2 && /Web Push працює на iOS 16\.4\+ \[1\]/.test(stepCards[0].querySelector(".ptext").textContent) && !![...stepCards[0].querySelectorAll("button")].find((b) => b.textContent.includes("Зберегти")));
  check("крок 2: два варіанти з лінійкою на 280 символів", stepCards[1].querySelectorAll(".vt button").length === 2 && /\/ 280 симв\./.test(stepCards[1].textContent));
  check("крок 2: немає кнопки «Згенерувати знову» (без звіту вона дала б інший результат)", !stepCards[1].querySelector("[aria-label=\"Згенерувати знову\"]"));
  check("крок 3: картка перевірки без кнопки виправлень", /Зауважень немає/.test(stepCards[2].textContent) && !/Застосувати виправлення/.test(stepCards[2].textContent));
  [...stepCards[0].querySelectorAll("button")].find((b) => b.textContent.includes("Зберегти")).click(); await sleep(300);
  await tab("Бібліотека");
  check("звіт ланцюга збережено як «Пошук: тема» без префікса платформи", qa(".itemhead .nm").some((e) => /^Пошук: Background Sync у Safari/.test(e.textContent.trim())), qa(".itemhead .nm").map((e) => e.textContent).join(" | "));

  // Журнал запусків: ланцюг одним записом, кроки всередині, читабельний вихід
  byText(".seg button", "Журнал запусків").click(); await sleep(150);
  const chainItem = () => qa(".item.chain")[0];
  check("журнал: ланцюг одним записом із назвою рецепта й темою", !!chainItem() && /^Пост з дослідженням · X: Background Sync у Safari/.test(chainItem().querySelector(".nm").textContent.trim()), chainItem()?.querySelector(".nm")?.textContent);
  check("журнал: підпис показує агентів і суму витрат ланцюга", /Пошук → Пости → Перевірка/.test(chainItem().querySelector(".dt").textContent) && /(<\$0,01|\$0,\d\d)/.test(chainItem().querySelector(".tkn").textContent), chainItem()?.textContent);
  check("журнал: кроки згорнуті, поки ланцюг не відкрито", qa(".item.nested").length === 0);
  chainItem().querySelector(".itemhead").click(); await sleep(120);
  const nestedNames = qa(".item.nested .itemhead .nm").map((e) => e.textContent.trim());
  check("журнал: три кроки з номерами", nestedNames.join(" | ") === "Крок 1 з 3 · Пошук | Крок 2 з 3 · Пости | Крок 3 з 3 · Перевірка", nestedNames.join(" | "));
  qa(".item.nested .itemhead")[1].click(); await sleep(120);
  const pv = q(".item.nested .pv");
  check("журнал: пости читабельно (варіанти, хештеги, довжина), а не сирий JSON", !!pv && /Web Push на iOS працює лише для PWA/.test(pv.textContent) && /#PWA/.test(pv.textContent) && /\/ 280 симв\./.test(pv.textContent) && !/"platform"|"variants"/.test(q(".item.nested").parentElement.textContent), pv?.textContent.slice(0, 120));
  qa(".item.nested .itemhead")[2].click(); await sleep(120);
  check("журнал: перевірка читабельно (картка вердикту, без кнопки виправлень)", !!q(".item.nested .rv") && /Зауважень немає/.test(q(".item.nested .rv").textContent) && !/Застосувати виправлення/.test(q(".item.nested").parentElement.textContent) && !/"verdict"/.test(q(".item.nested").parentElement.textContent));

  // Ліміт вартості ланцюга: налаштування, підтвердження, зупинка
  await tab("Параметри");
  const lim = () => q("#chain-limit");
  check("параметри: ліміт ланцюга за замовчуванням $0,25", lim().value === "0,25");
  setVal(lim(), "0,01"); lim().focus(); lim().blur(); await sleep(120);
  check("ліміт збережено на пристрої", w.localStorage.getItem("wb.chainLimit") === "0.01" && /Ліміт ланцюга/.test(q(".toast").textContent), w.localStorage.getItem("wb.chainLimit"));
  await tab("Робота");
  const before4b = posts.length;
  await runChainCmd("/пост-з-пошуком X: Ще одна тема");
  const gated = await waitFor(() => /Ліміт вартості ланцюга/.test(q(".sheet.on")?.textContent ?? ""));
  check("оцінка кроку перевищує ліміт: шторка з витратами й назвою кроку", gated && /Наступний крок «Пошук»/.test(q(".sheet.on").textContent) && /з \$0,01/.test(q(".sheet.on").textContent), q(".sheet.on")?.textContent);
  check("до підтвердження запитів немає", posts.length === before4b);
  byText(".sheet.on button", "Зупинити").click();
  const stopped = await waitFor(() => /Зупинено: перевищено ліміт вартості/.test(chains().at(-1)?.textContent ?? "") && !q(".go.stop"));
  check("відмова зупиняє ланцюг без запитів", stopped && posts.length === before4b, chains().at(-1)?.textContent);

  seq = chainSeq();
  await runChainCmd("/пост-з-пошуком X: Ще одна тема");
  const gateTexts = [];
  for (let n = 0; n < 3; n++) {
    const ok = await waitFor(() => !!q(".sheet.on button.primary"));
    if (!ok) break;
    gateTexts.push(q(".sheet.on").textContent);
    byText(".sheet.on button", "Продовжити").click();
    await sleep(150);
  }
  const done2 = await waitFor(() => /Готово/.test(chains().at(-1)?.textContent ?? "") && !q(".go.stop"), 8000);
  check("підтвердження кожного кроку: три шторки, ланцюг доведено до кінця", gateTexts.length === 3 && done2, gateTexts.length + " шторок");
  check("друга шторка враховує вже витрачене", /Витрачено (<\$0,01|\$0,\d\d) з \$0,01/.test(gateTexts[1] ?? "") && /«Пости»/.test(gateTexts[1] ?? ""), gateTexts[1]);
  setVal(lim(), ""); await tab("Параметри");
  setVal(lim(), "0,25"); lim().focus(); lim().blur(); await sleep(100);
  check("ліміт повернуто до $0,25", w.localStorage.getItem("wb.chainLimit") === "0.25");
  await tab("Робота");
  setVal(taskInput(), ""); await sleep(30);

  // Цикл «Перевірка → виправлення»: вердикт needs_changes → пости виправляються → повторна перевірка
  const retrySeq = () => [
    searchStep,
    answerStep,
    () => toolTurn({ name: "submit_posts", input: { platform: "x", variants: [{ text: "Web Push на iOS працює лише для PWA з початкового екрана.", hashtags: ["PWA"] }] } }),
    () => toolTurn({ name: "submit_review", input: { verdict: "needs_changes", score: 6, summary: "Є фактична неточність", issues: [{ severity: "medium", category: "facts", quote: "працює лише для PWA", problem: "Не вказано версію iOS", suggestion: "Додай iOS 16.4+" }] } }),
    () => toolTurn({ name: "submit_posts", input: { platform: "x", variants: [{ text: "Виправлено: Web Push на iOS працює лише для PWA з iOS 16.4+.", hashtags: ["PWA"] }] } }),
    () => toolTurn({ name: "submit_review", input: { verdict: "ok", score: 9, summary: "Факти збігаються", issues: [] } }),
  ];
  const beforeR = posts.length;
  const cR = chains().length;
  seq = retrySeq();
  await runChainCmd("/пост-з-пошуком X: Тема з виправленням");
  const doneR = await waitFor(() => chains().length === cR + 1 && /Готово/.test(chains().at(-1).textContent) && !q(".go.stop"), 10000);
  const barR = chains().at(-1);
  const namesR = [...barR.querySelectorAll(".csteps .cs")].map((e) => e.textContent.replace(/[✓●○■✕]/g, "").trim());
  check("цикл виправлення: смужка зростає до п'яти кроків, усі виконані", doneR && namesR.join("|") === "Пошук|Пости|Перевірка|Пости (виправлення)|Перевірка (повтор)" && [...barR.querySelectorAll(".csteps .cs")].every((e) => e.classList.contains("done")), namesR.join("|"));
  check("цикл виправлення: шість запитів (пошук із паузою, пости, перевірка, виправлення, повтор)", posts.length === beforeR + 6, String(posts.length - beforeR));
  const fixReq = uptext(posts[beforeR + 4]);
  check("виправлення бачить звіт, попередній варіант і зауваження, усе як недовірений вміст", /<untrusted_content source="web-derived">/.test(fixReq) && /Попередні варіанти/.test(fixReq) && /Web Push на iOS працює лише для PWA з початкового екрана/.test(fixReq) && /Не вказано версію iOS/.test(fixReq) && /Web Push працює на iOS 16\.4\+/.test(fixReq) && /Виправ варіанти за зауваженнями/.test(posts[beforeR + 4].messages[0].content.at(-1).text));
  const redoReq = uptext(posts[beforeR + 5]);
  check("повторна перевірка бачить виправлений пост, а не старий", /Виправлено: Web Push на iOS/.test(redoReq) && !/працює лише для PWA з початкового екрана/.test(redoReq));
  const labelsR = qa("section[aria-label=\"Робота\"] p.note").map((e) => e.textContent.replace(/\s+/g, " ").trim());
  check("картки доопрацювання підписані без «з N»", labelsR.some((t) => /^Крок 4 · Пости \(виправлення\)/.test(t)) && labelsR.some((t) => /^Крок 5 · Перевірка \(повтор\)/.test(t)), labelsR.filter((t) => /Крок [45]/.test(t)).join(" | "));
  const cardsR = feedCards().slice(-5);
  check("перша перевірка показує зауваження, повторна без зауважень", /Не вказано версію iOS/.test(cardsR[2].textContent) && /Зауважень немає/.test(cardsR[4].textContent));
  await tab("Бібліотека"); byText(".seg button", "Журнал запусків").click(); await sleep(150);
  qa(".item.chain")[0].querySelector(".itemhead").click(); await sleep(120);
  const nestedR = [...qa(".item.chain")[0].querySelectorAll(".item.nested .itemhead .nm")].map((e) => e.textContent.trim());
  check("журнал: п'ять кроків, виправлення й повтор підписані", nestedR.join(" | ") === "Крок 1 з 3 · Пошук | Крок 2 з 3 · Пости | Крок 3 з 3 · Перевірка | Крок 4 · Пости (виправлення) | Крок 5 · Перевірка (повтор)", nestedR.join(" | "));
  await tab("Робота");
  setVal(taskInput(), ""); await sleep(30);

  // Запуск рецепта без слеша й вибір рецепта у шторці агентів (T4.2d)
  const cS = chains().length;
  const beforeS = posts.length;
  seq = chainSeq();
  await runChainCmd("Пост-з-пошуком X: Тема без слеша");
  const doneS = await waitFor(() => chains().length === cS + 1 && /Готово/.test(chains().at(-1).textContent) && !q(".go.stop"), 8000);
  check("рецепт запускається без слеша (з автоверхнім регістром iOS)", doneS && posts.length === beforeS + 4 && /Тема без слеша/.test(chains().at(-1).textContent), chains().at(-1)?.textContent);
  check("перший запит ланцюга без слеша це «Пошук» (веб-пошук), а не звичайний запуск «Постів»", !!posts[beforeS].tools.find((t) => t.type === "web_search_20250305"));

  q(".agentbtn").click(); await sleep(100);
  const sheetS = q(".sheet.on");
  check("шторка агентів: розділ «Рецепти» з назвою, описом і командою", !!sheetS && /Рецепти/.test(sheetS.textContent) && /Пост з дослідженням/.test(sheetS.textContent) && /\/пост-з-пошуком/.test(sheetS.textContent) && /ланцюг/.test(sheetS.textContent), sheetS?.textContent.slice(-300));
  setVal(taskInput(), ""); await sleep(30);
  byText(".sheet.on .agent", "Пост з дослідженням").click(); await sleep(150);
  check("вибір рецепта: шторка закрита, команда підставлена в поле, підказка з прикладом", !q(".sheet.on") && taskInput().value === "/пост-з-пошуком " && /Пост з дослідженням: допишіть платформу й тему/.test(q(".toast").textContent), taskInput().value + " | " + q(".toast")?.textContent);
  seq = chainSeq();
  setVal(taskInput(), taskInput().value + "X: Тема з шторки"); await sleep(60); q(".go").click();
  const doneP = await waitFor(() => chains().length === cS + 2 && /Готово/.test(chains().at(-1).textContent) && !q(".go.stop"), 8000);
  check("рецепт із шторки доведено до кінця", doneP && /Тема з шторки/.test(chains().at(-1).textContent), chains().at(-1)?.textContent);
  setVal(taskInput(), "linkedin: вже набрана тема"); await sleep(30);
  q(".agentbtn").click(); await sleep(100);
  byText(".sheet.on .agent", "Пост з дослідженням").click(); await sleep(150);
  check("вибір рецепта зберігає вже набраний текст після команди", taskInput().value === "/пост-з-пошуком linkedin: вже набрана тема", taskInput().value);
  setVal(taskInput(), ""); await sleep(30);

  // Роутер (T4.3): режим «Авто» у шторці агентів, план показується завжди, виконання після підтвердження
  const routerTurn = (input) => () => toolTurn({ name: "route_decision", input });
  const planCard = () => qa("section.plan").at(-1);
  const sendTask = async (text) => { setVal(taskInput(), text); await sleep(60); q(".go").click(); };

  q(".agentbtn").click(); await sleep(100);
  const autoItem = qa(".sheet.on .agent")[0];
  check("шторка агентів: «Авто» першим пунктом з описом", !!autoItem && /^✦?Авто/.test(autoItem.textContent.trim()) && /роутер запропонує/.test(autoItem.textContent), autoItem?.textContent);
  autoItem.click(); await sleep(150);
  check("режим «Авто» увімкнено: заголовок і підказка", /Авто/.test(q(".agentbtn").getAttribute("aria-label")) && !q(".sheet.on") && /Авто/.test(q(".toast").textContent), q(".agentbtn")?.getAttribute("aria-label"));

  const beforeA = posts.length;
  const cA = chains().length;
  seq = [routerTurn({ summary: "Пост з дослідженням для X про тему від роутера", confidence: 0.92, steps: [], recipe: "post-research", recipeInput: "x: Тема від роутера" })];
  await sendTask("зроби пост для X про тему від роутера з дослідженням");
  const planned = await waitFor(() => !!planCard());
  check("вільний текст у режимі «Авто» дає картку плану", planned, "картки немає");
  const reqA = posts[beforeA];
  check("запит роутера: модель fast, один інструмент route_decision, tool_choice auto, без temperature", posts.length === beforeA + 1 && /haiku/.test(reqA.model) && reqA.tools.length === 1 && reqA.tools[0].name === "route_decision" && reqA.tool_choice.type === "auto" && !("temperature" in reqA), JSON.stringify(reqA?.tool_choice));
  check("задача в запиті роутера в тегу <task>", /<task>\nзроби пост для X про тему від роутера/.test(reqA.messages[0].content[0].text));
  check("план нічого не запустив: лише запит роутера, поле вводу порожнє", posts.length === beforeA + 1 && taskInput().value === "" && chains().length === cA);
  const cardA = planCard();
  check("картка плану: підсумок, три кроки, рецепт, впевненість, оцінка й ліміт", /Пост з дослідженням для X/.test(cardA.textContent) && [...cardA.querySelectorAll(".psteps li strong")].map((e) => e.textContent).join("|") === "Пошук|Пости|Перевірка" && /Рецепт «Пост з дослідженням»/.test(cardA.textContent) && /впевненість 0,92/.test(cardA.textContent) && /Оцінка до \$0,\d\d/.test(cardA.textContent) && /ліміт ланцюга \$0,25/.test(cardA.textContent) && /роутер/.test(cardA.textContent), cardA.textContent.slice(0, 260));
  check("картка плану: кнопки «Запустити» і «Скасувати й змінити»", !!byText("section.plan button", "Запустити") && !!byText("section.plan button", "Скасувати й змінити"));

  byText("section.plan button", "Скасувати й змінити").click(); await sleep(150);
  check("скасування: задача повернулась у поле, картка позначена, запитів немає", taskInput().value === "зроби пост для X про тему від роутера з дослідженням" && /Скасовано/.test(planCard().textContent) && !byText("section.plan button", "Запустити") && posts.length === beforeA + 1, taskInput().value);

  seq = [routerTurn({ summary: "Пост з дослідженням для X про тему від роутера", confidence: 0.92, steps: [], recipe: "post-research", recipeInput: "x: Тема від роутера" })];
  q(".go").click();
  await waitFor(() => qa("section.plan").length === 2 && !!byText("section.plan button", "Запустити"));
  seq = chainSeq();
  byText("section.plan button", "Запустити").click();
  const doneA = await waitFor(() => chains().length === cA + 1 && /Готово/.test(chains().at(-1).textContent) && !q(".go.stop"), 10000);
  check("підтверджений план виконується як ланцюг: заголовок рецепта, три кроки виконані", doneA && /Пост з дослідженням/.test(chains().at(-1).textContent) && /Тема від роутера/.test(chains().at(-1).textContent) && [...chains().at(-1).querySelectorAll(".csteps .cs.done")].length === 3, chains().at(-1)?.textContent);
  check("після запуску картка плану без кнопок: «Запущено»", /Запущено/.test(planCard().textContent) && !byText("section.plan button", "Запустити"));
  check("запити: роутер, потім пошук, пости, перевірка (6 запитів із паузою пошуку)", posts.length === beforeA + 1 + 1 + 4, String(posts.length - beforeA));

  // Один агент: звичайний запуск (не ланцюг), задача для агента це інструкція роутера
  const beforeB = posts.length;
  const cB = chains().length;
  seq = [routerTurn({ summary: "Скоротити текст", confidence: 0.88, steps: [{ agentId: "docs", instruction: "Скороти текст до двох речень" }] })];
  await sendTask("скороти це");
  await waitFor(() => qa("section.plan").length === 3);
  check("план з одного агента: один крок без рецепта", [...planCard().querySelectorAll(".psteps li")].length === 1 && /Документи/.test(planCard().textContent) && !/Рецепт/.test(planCard().textContent), planCard()?.textContent.slice(0, 200));
  seq = [textTurn];
  byText("section.plan button", "Запустити").click();
  await waitFor(() => posts.length === beforeB + 2 && !q(".go.stop"), 6000);
  check("одинарний план запускає звичайного агента (не ланцюг) з інструкцією роутера", chains().length === cB && /Скороти текст до двох речень/.test(posts.at(-1).messages[0].content.at(-1).text) && !posts.at(-1).tools.some((t) => t.name === "route_decision"), String(chains().length - cB));
  check("результат агента показано карткою після плану", qa(".task span").some((e) => /Скороти текст до двох речень/.test(e.textContent)) && /Готовий текст відповіді/.test(q("section[aria-label=\"Робота\"]").textContent));

  // Низька впевненість і уточнення
  seq = [routerTurn({ summary: "Щось із текстом", confidence: 0.45, steps: [{ agentId: "docs", instruction: "Зроби щось із текстом" }] })];
  await sendTask("зроби з цим щось");
  await waitFor(() => qa("section.plan").length === 4);
  check("низька впевненість: попередження й кнопка «Запустити все одно»", /не певен/.test(planCard().textContent) && /впевненість 0,45/.test(planCard().textContent) && !!byText("section.plan button", "Запустити все одно"), planCard()?.textContent.slice(0, 200));
  byText("section.plan button", "Скасувати й змінити").click(); await sleep(100);
  seq = [routerTurn({ summary: "Бракує теми", confidence: 0.3, steps: [], clarify: "Про що має бути пост і для якої платформи?" })];
  setVal(taskInput(), "зроби пост"); await sleep(40); q(".go").click();
  await waitFor(() => qa("section.plan").length === 5);
  check("уточнення: питання замість плану, без кнопки «Запустити»", /Потрібне уточнення/.test(planCard().textContent) && /Про що має бути пост/.test(planCard().textContent) && !byText("section.plan button", "Запустити") && !!byText("section.plan button", "Уточнити задачу"));
  byText("section.plan button", "Уточнити задачу").click(); await sleep(100);
  check("«Уточнити задачу» повертає текст у поле", taskInput().value === "зроби пост");
  setVal(taskInput(), ""); await sleep(30);

  // Помилка роутера: модель двічі не викликала інструмент
  const beforeE = posts.length;
  seq = [textTurn, textTurn];
  await sendTask("щось незрозуміле");
  const errShown = await waitFor(() => /Роутер не склав коректний план/.test(q("section[aria-label=\"Робота\"]").textContent));
  check("помилка роутера: повідомлення, два запити (повтор), текст повернуто в поле", errShown && posts.length === beforeE + 2 && taskInput().value === "щось незрозуміле", String(posts.length - beforeE));
  setVal(taskInput(), ""); await sleep(30);

  // Команди й рецепти обходять роутер навіть у режимі «Авто»
  const beforeC = posts.length;
  seq = chainSeq();
  await sendTask("Пост-з-пошуком X: Тема без роутера");
  await waitFor(() => /Тема без роутера/.test(chains().at(-1)?.textContent ?? "") && /Готово/.test(chains().at(-1).textContent) && !q(".go.stop"), 10000);
  check("рецепт у режимі «Авто» не викликає роутер (перший запит це пошук)", !posts.slice(beforeC).some((b) => b.tools?.some((t) => t.name === "route_decision")) && !!posts[beforeC].tools.find((t) => t.type === "web_search_20250305"));
  const beforeD = posts.length;
  seq = [textTurn];
  await sendTask("/док скороти цей текст");
  await waitFor(() => posts.length === beforeD + 1 && !q(".go.stop"), 6000);
  check("команда агента обходить роутер і виводить із режиму «Авто»", !posts[beforeD].tools.some((t) => t.name === "route_decision") && !/Авто/.test(q(".agentbtn").getAttribute("aria-label")) && /Документи/.test(q(".agentbtn").getAttribute("aria-label")), q(".agentbtn")?.getAttribute("aria-label"));
  setVal(taskInput(), ""); await sleep(30);

  // Передача завдань (T4.4): «Документи» передають пошук, користувач підтверджує з оцінкою, результат і журнал
  await tab("Робота");
  q(".agentbtn").click(); await sleep(100);
  byText(".sheet.on .agent", "Документи").click(); await sleep(120);
  const handoffTurn = () => toolTurn({ name: "handoff", input: { agentId: "search", instruction: "Знайди першоджерело про Web Push на iOS і назви версію" } });
  const beforeH = posts.length;
  seq = [handoffTurn, searchStep, answerStep, textTurn];
  setVal(taskInput(), "допиши джерело до твердження про Web Push"); await sleep(60); q(".go").click();
  const gateH = await waitFor(() => /Передача завдання/.test(q(".sheet.on")?.textContent ?? ""));
  check("handoff: шторка підтвердження з назвами агентів, інструкцією й оцінкою вартості", gateH && /«Документи» просить передати завдання «Пошук»/.test(q(".sheet.on").textContent) && /Оцінка вартості до \$0,\d\d/.test(q(".sheet.on").textContent), q(".sheet.on")?.textContent?.slice(0, 260));
  check("до підтвердження вкладеного запиту ще немає", posts.length === beforeH + 1);
  byText(".sheet.on button", "Дозволити").click();
  const doneH = await waitFor(() => posts.length === beforeH + 4 && !q(".go.stop"), 8000);
  check("після «Дозволити»: вкладений пошук (з веб-інструментом), потім відповідь батька", doneH && posts[beforeH + 2].tools.some((t) => t.type === "web_search_20250305") && !posts[beforeH + 2].tools.some((t) => t.name === "handoff"), String(posts.length - beforeH));
  const resH = posts[beforeH + 3].messages.at(-1).content[0];
  check("результат передачі повернуто батькові як недовірений вміст (tool_result без is_error)", resH.type === "tool_result" && !resH.is_error && /<untrusted_content source="web-derived">/.test(resH.content) && /Джерела:/.test(resH.content));
  const cardH = feedCards().at(-1);
  check("картка батька: видно передачі в статусі запуску", /передач 1/.test(cardH.textContent), cardH.textContent.slice(-200));
  await tab("Бібліотека"); byText(".seg button", "Журнал запусків").click(); await sleep(150);
  let handRun = qa(".item").find((e) => /допиши джерело/.test(e.textContent));
  if (handRun) { handRun.querySelector(".itemhead").click(); await sleep(120); handRun = qa(".item").find((e) => /допиши джерело/.test(e.textContent)); }
  check("журнал: один запис батька, у ньому рядок передачі з вартістю", !!handRun && /Передача → Пошук/.test(handRun.textContent) && qa(".item").filter((e) => /допиши джерело/.test(e.textContent)).length === 1, handRun?.textContent.slice(0, 200));
  await tab("Робота");
  setVal(taskInput(), ""); await sleep(30);

  // Відмова від передачі: агент продовжує без неї
  const beforeR2 = posts.length;
  seq = [handoffTurn, textTurn];
  setVal(taskInput(), "ще раз про Web Push"); await sleep(60); q(".go").click();
  await waitFor(() => !!byText(".sheet.on button", "Відмовити"));
  byText(".sheet.on button", "Відмовити").click();
  const declined = await waitFor(() => posts.length === beforeR2 + 2 && !q(".go.stop"), 6000);
  const resD = posts[beforeR2 + 1].messages.at(-1).content[0];
  check("відмова: вкладеного запиту немає, агент отримує is_error і продовжує", declined && resD.is_error === true && posts.length === beforeR2 + 2, String(posts.length - beforeR2));
  setVal(taskInput(), ""); await sleep(30);

  // Імпорт бази: Пам'ять → імпорт пакета
  await tab("Параметри");
  check("параметри показують режим і адресу", /вкладка браузера · app\.test/.test(q("section[aria-label=Налаштування]").textContent), q("section[aria-label=Налаштування]").textContent.match(/Зараз:[^\n]*/)?.[0]);
  [...q("section[aria-label=Налаштування]").querySelectorAll("button")].find((b) => b.textContent.includes("Імпортувати")).click(); await sleep(80);
  check("шторка імпорту відкрита", /Імпорт бази/.test(q(".sheet.on")?.textContent ?? ""));
  setVal(q(".sheet.on textarea"), "не json"); await sleep(50);
  check("некоректний текст дає помилку й блокує імпорт", !!q(".sheet.on .warn") && byText(".sheet.on button", "Імпортувати").disabled);
  setVal(q(".sheet.on textarea"), JSON.stringify({ profile: { tone: "діловий, прямий" }, memory: [{ text: "Імпортований факт про стек", pinned: true }, { text: "Другий факт" }] })); await sleep(50);
  check("попередній перегляд показує кількість", /профіль, фактів: 2/.test(q(".sheet.on .note.tnum")?.textContent ?? ""), q(".sheet.on .note.tnum")?.textContent);
  byText(".sheet.on button", "Імпортувати").click(); await sleep(400);
  check("імпорт завершено, шторка закрита", !q(".sheet.on") && /Імпортовано: профіль, фактів 2/.test(q(".toast").textContent), q(".toast").textContent);
  await tab("Пам'ять");
  check("імпортовані факти видно в «Пам'яті»", !!byText(".fact .ftext", "Імпортований факт") && !!byText(".fact .ftext", "Другий факт"));
  check("профіль оновлено з імпорту", q("textarea[placeholder='діловий, без канцеляризмів']").value === "діловий, прямий");

  // Копія й діагностика сховища
  await tab("Параметри");
  const settings = () => q("section[aria-label=Налаштування]");
  const sbtn = (t) => [...settings().querySelectorAll("button")].find((b) => b.textContent.includes(t));
  await sleep(200);
  check("«Стан сховища»: дата створення й лічильники", /Сховище створено:/.test(settings().textContent) && /У базі: профіль .*фактів \d+/.test(settings().textContent));
  check("копії ще немає", /Копії ще немає/.test(settings().textContent));
  sbtn("Перевірити запис у сховище").click(); await sleep(300);
  check("самоперевірка запису проходить", /Запис і читання працюють/.test(settings().textContent));
  sbtn("Зберегти копію зараз").click(); await sleep(500);
  check("копію збережено й показано в параметрах", /Копію збережено/.test(q(".toast").textContent) && /Остання копія:.*фактів \d+/.test(settings().textContent), q(".toast").textContent);
  check("у хмарну копію пішли профіль і факти, а не журнал запусків", backups.latest.counts.memory >= 2 && !("runs" in backups.latest.data));
  backups.latest.data.memory.push({ text: "Факт лише з хмарної копії", tags: [], source: "user" });
  sbtn("Відновити з копії").click(); await sleep(500);
  check("відновлення додає лише відсутнє", /Відновлено:.*фактів 1/.test(q(".toast").textContent), q(".toast").textContent);
  await tab("Пам'ять");
  check("відновлений факт видно в «Пам'яті»", !!byText(".fact .ftext", "Факт лише з хмарної копії"));
  check("банера відновлення немає, коли локальні дані є", !q(".offer"));

  // Налаштування
  await tab("Параметри");
  check("витрати з проксі на екрані параметрів", /\$0,50 з \$3,00/.test(q("#s-settings, section[aria-label=Налаштування]").textContent));

  console.log("\nпомилки в консолі/вікні:", errors.length ? errors : "немає");
  if (errors.length) process.exitCode = 1;
  process.exit();
})().catch((e) => { console.error("СКРИПТ ВПАВ:", e); process.exit(2); });
