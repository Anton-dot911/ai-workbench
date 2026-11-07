import MiniSearch from "minisearch";
import { db } from "../db/db";
import { getDataVersion } from "../db/changes";
import type { ArtifactType } from "./types";

// Повнотекстовий пошук BM25 по пам'яті й артефактах (без ембедингів і без викликів моделі).
// Українська морфологія: слова обрізаються до 6 літер («документи», «документів», «документами» → «докуме»),
// плюс префіксний і нечіткий збіг.

const STOP = new Set(
  "і й та в у на з із зі до що як це для не по від за про або але чи те той ця цей ці всі усі був була були є щоб при під над між".split(" "),
);

export function normalizeTerm(raw: string): string | null {
  const t = raw.toLowerCase().replace(/['’ʼ`]/g, "");
  if (t.length < 2 || STOP.has(t)) return null;
  return t.length > 6 ? t.slice(0, 6) : t;
}

const tokenize = (s: string): string[] => s.split(/[^\p{L}\p{N}'’ʼ]+/u).filter(Boolean);

interface Doc {
  id: string;
  kind: "memory" | "artifact";
  type: string;
  ref: string;
  title: string;
  body: string;
  tags: string;
}

const OPTIONS = {
  fields: ["title", "body", "tags"],
  storeFields: ["kind", "type", "ref"],
  tokenize,
  processTerm: normalizeTerm,
};

let index: MiniSearch<Doc> | null = null;
let builtAt = -1;
let building: Promise<MiniSearch<Doc>> | null = null;

async function getIndex(): Promise<MiniSearch<Doc>> {
  if (index && builtAt === getDataVersion()) return index;
  if (!building) {
    building = (async () => {
      const at = getDataVersion();
      const [mem, arts] = await Promise.all([db.memory.toArray(), db.artifacts.toArray()]);
      const ms = new MiniSearch<Doc>(OPTIONS);
      ms.addAll([
        ...mem.map<Doc>((m) => ({ id: `m:${m.id}`, kind: "memory", type: "", ref: m.id, title: "", body: m.text, tags: m.tags.join(" ") })),
        ...arts.map<Doc>((a) => ({
          id: `a:${a.id}`,
          kind: "artifact",
          type: a.type,
          ref: a.id,
          title: a.title,
          body: `${a.summary} ${a.content.slice(0, 3000)}`,
          tags: "",
        })),
      ]);
      index = ms;
      builtAt = at;
      return ms;
    })().finally(() => {
      building = null;
    });
  }
  return building;
}

export interface Hit {
  kind: "memory" | "artifact";
  id: string;
  score: number;
}

export interface RetrieveOptions {
  kind?: "memory" | "artifact";
  types?: ArtifactType[];
  topK: number;
  exclude?: Set<string>;
}

/** Топ-K записів за запитом. Результати значно слабші за найкращий відсікаються (поріг 25 % від топ-оцінки). */
export async function retrieve(query: string, opts: RetrieveOptions): Promise<Hit[]> {
  if (!query.trim()) return [];
  const idx = await getIndex();
  const res = idx.search(query, {
    prefix: true,
    fuzzy: 0.2,
    combineWith: "OR",
    boost: { title: 3, tags: 2 },
    filter: (r) =>
      (!opts.kind || r.kind === opts.kind) &&
      (!opts.types || r.kind !== "artifact" || opts.types.includes(r.type as ArtifactType)) &&
      !opts.exclude?.has(r.ref as string),
  });
  if (!res.length) return [];
  const floor = res[0].score * 0.25;
  return res
    .filter((r) => r.score >= floor)
    .slice(0, opts.topK)
    .map((r) => ({ kind: r.kind as Hit["kind"], id: r.ref as string, score: r.score }));
}
