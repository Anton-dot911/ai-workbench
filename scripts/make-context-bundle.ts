// Збирає файл імпорту з документами проєкту для «Бібліотеки» (контекст агента «Інженер»).
// Використання: npx tsx scripts/make-context-bundle.ts out.json README.md PLAN.md src/db/importexport.ts …
// Кожен файл стає артефактом із назвою «шлях @sha» (sha поточного коміту), щоб у пакеті було видно, на якому стані
// проєкту він збудований. Імпортується на iPhone через «Параметри → Імпортувати» (лише додає, дублів не створює).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseBundle } from "../src/db/importexport";

const [out, ...files] = process.argv.slice(2);
if (!out || files.length === 0) {
  console.error("Використання: npx tsx scripts/make-context-bundle.ts out.json <файл> [<файл> …]");
  process.exit(1);
}
const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const now = Date.now();
const firstLine = (t: string): string => (t.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---")) ?? t).trim().slice(0, 160);

const artifacts = files.map((f) => {
  const content = readFileSync(f, "utf8");
  const slug = f.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return {
    id: `ctx-${slug}-${sha}`,
    type: f.endsWith(".md") ? "document" : "code",
    title: `${f} @${sha}`,
    content,
    summary: firstLine(content) || f,
    versions: [{ at: now, content }],
    updatedAt: now,
  };
});

const bundle = { app: "ai-workbench", schema: 1, exportedAt: new Date(now).toISOString(), profile: [], memory: [], artifacts, runs: [] };
const text = JSON.stringify(bundle);
const check = parseBundle(text);
if (!check.ok) throw new Error(`Файл не пройшов перевірку імпорту: ${check.error}`);
if (check.bundle.invalid) throw new Error(`${check.bundle.invalid} записів відхилено схемою імпорту`);
writeFileSync(out, text);
console.log(`${out}: ${artifacts.length} документів @${sha}, ${(text.length / 1024).toFixed(0)} КБ`);
for (const a of artifacts) console.log(`  ${a.type.padEnd(8)} ${a.title} (${(a.content.length / 1024).toFixed(0)} КБ)`);
