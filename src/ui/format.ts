export const fmt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");

export const tk = (n: number): string =>
  n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "").replace(".", ",") + "k" : String(Math.round(n));

export const money = (usd: number): string =>
  usd < 0.005 ? "<$0,01" : "$" + usd.toFixed(2).replace(".", ",");

export const when = (ts: number): string =>
  new Date(ts).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
