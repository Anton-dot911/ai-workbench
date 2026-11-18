import type { Artifact } from "../core/types";
import { db } from "../db/db";
import { canTransition, PackageError, parsePackage, sameSpec, type EngineeringPackage } from "./package";

// Пакети зберігаються як артефакти типу `engineering_package` (content = JSON пакета): версії чернетки, експорт, імпорт
// і хмарна копія працюють як для решти артефактів. Кожна версія пакета це окремий запис `${packageId}@${version}`.

export const packageArtifactId = (p: Pick<EngineeringPackage, "packageId" | "version">): string => `${p.packageId}@${p.version}`;

const fields = (pkg: EngineeringPackage) => ({
  title: `Пакет: ${pkg.projectId} v${pkg.version} · ${pkg.status}`.slice(0, 80),
  summary: (pkg.summary.trim() || `${pkg.requirements.length} вимог · ${pkg.components.length} компонентів · ${pkg.tasks.length} задач`).slice(0, 200),
});

/**
 * Зберігає пакет. Нова версія може бути лише чернеткою. Зафіксовану версію (не DRAFT) змінити не можна: дозволено лише
 * законний перехід статусу з тим самим вмістом. Зміни вмісту чернетки зберігаються в `versions` артефакту.
 */
export async function savePackage(pkg: EngineeringPackage): Promise<Artifact> {
  const id = packageArtifactId(pkg);
  const now = Date.now();
  const content = JSON.stringify(pkg);
  const existing = await db.artifacts.get(id);

  if (!existing) {
    if (pkg.status !== "DRAFT") throw new PackageError("Нова версія пакета створюється лише як чернетка.");
    const artifact: Artifact = { id, type: "engineering_package", ...fields(pkg), content, versions: [{ at: now, content }], updatedAt: now };
    await db.artifacts.add(artifact);
    return artifact;
  }

  const old = parsePackage(existing.content);
  if (old.ok) {
    if (old.package.status !== "DRAFT" && !sameSpec(old.package, pkg)) throw new PackageError("Зафіксована версія пакета незмінна: створіть ревізію (revise).");
    if (old.package.status !== pkg.status && !canTransition(old.package.status, pkg.status)) throw new PackageError(`Перехід ${old.package.status} → ${pkg.status} неможливий.`);
  }
  const artifact: Artifact = { ...existing, ...fields(pkg), content, versions: existing.content === content ? existing.versions : [...existing.versions, { at: now, content }], updatedAt: now };
  await db.artifacts.put(artifact);
  return artifact;
}

export async function loadPackage(artifactId: string): Promise<EngineeringPackage | null> {
  const a = await db.artifacts.get(artifactId);
  if (!a || a.type !== "engineering_package") return null;
  const p = parsePackage(a.content);
  return p.ok ? p.package : null;
}

const versionKey = (v: string): number => {
  const [major, minor] = v.split(".").map(Number);
  return major * 1000 + minor;
};

/** Усі пакети; для кожного packageId лише остання версія. */
export async function listPackages(): Promise<EngineeringPackage[]> {
  const rows = await db.artifacts.where("type").equals("engineering_package").toArray();
  const latest = new Map<string, EngineeringPackage>();
  for (const a of rows) {
    const p = parsePackage(a.content);
    if (!p.ok) continue;
    const cur = latest.get(p.package.packageId);
    if (!cur || versionKey(p.package.version) > versionKey(cur.version)) latest.set(p.package.packageId, p.package);
  }
  return [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
