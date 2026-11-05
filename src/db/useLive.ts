import { liveQuery } from "dexie";
import { useEffect, useState } from "react";

/** Підписка на запит Dexie: компонент оновлюється, коли дані в IndexedDB змінюються. */
export function useLive<T>(query: () => T | Promise<T>, initial: T, deps: unknown[] = []): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: (e) => console.error(e) });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
