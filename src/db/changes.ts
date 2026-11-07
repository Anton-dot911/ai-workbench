import { useSyncExternalStore } from "react";

// Лічильник змін даних: індекс пошуку й попередній перегляд контексту оновлюються, коли він росте.
let version = 0;
const subs = new Set<() => void>();

export const getDataVersion = (): number => version;
export function bumpDataVersion(): void {
  version++;
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
export const useDataVersion = (): number => useSyncExternalStore(subscribe, getDataVersion);
