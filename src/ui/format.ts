export const fmt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");

export const tk = (n: number): string =>
  n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "").replace(".", ",") + "k" : String(Math.round(n));

export const money = (usd: number): string =>
  usd < 0.005 ? "<$0,01" : "$" + usd.toFixed(2).replace(".", ",");

export const when = (ts: number): string =>
  new Date(ts).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const approx = (usd: number): string => (usd < 0.005 ? "<$0,01" : "≈" + money(usd));

/** Відмінювання за числом: 1 джерело, 2 джерела, 5 джерел. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
