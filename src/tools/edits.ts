// Редагування патчами замість переписування: дешевше, швидше і дає зрозумілий diff.

export interface ReplaceEdit {
  find: string;
  replace: string;
  reason?: string;
}
export interface InsertEdit {
  insertAfter: string;
  text: string;
  reason?: string;
}
export type Edit = ReplaceEdit | InsertEdit;

export interface EditFailure {
  index: number;
  error: string;
}

export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

export const isReplace = (e: Edit): e is ReplaceEdit => "find" in e;

/**
 * Послідовно застосовує правки. Правка не застосовується, якщо фрагмент не знайдено або він неоднозначний
 * (трапляється кілька разів). `only` обмежує набір правок (ті, що прийняв користувач).
 */
export function applyEdits(content: string, edits: Edit[], only?: Set<number>): { result: string; applied: number[]; failed: EditFailure[] } {
  let result = content;
  const applied: number[] = [];
  const failed: EditFailure[] = [];
  edits.forEach((e, index) => {
    if (only && !only.has(index)) return;
    const needle = isReplace(e) ? e.find : e.insertAfter;
    const n = countOccurrences(result, needle);
    if (n === 0) return void failed.push({ index, error: "фрагмент не знайдено" });
    if (n > 1) return void failed.push({ index, error: `неоднозначно: ${n} збігів, візьміть довший фрагмент` });
    const at = result.indexOf(needle);
    if (isReplace(e)) result = result.slice(0, at) + e.replace + result.slice(at + needle.length);
    else {
      const pos = at + needle.length;
      result = result.slice(0, pos) + e.text + result.slice(pos);
    }
    applied.push(index);
  });
  return { result, applied, failed };
}
