import { useSyncExternalStore } from "react";
import type { Task } from "./types";

// Стан поточної сесії, спільний для екранів «Робота», «Контекст» і «Бібліотека».
export interface Session {
  task: string;
  frag: string;
  turns: { task: string; output: string }[];
  toggles: Record<string, boolean>;
  extraArtifactIds: string[];
  /** Лічильник запитів на запуск (кнопка «Запустити з цим контекстом»). */
  runNonce: number;
}

let state: Session = { task: "", frag: "", turns: [], toggles: {}, extraArtifactIds: [], runNonce: 0 };
const subs = new Set<() => void>();

export const getSession = (): Session => state;

export function setSession(patch: Partial<Session> | ((s: Session) => Partial<Session>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  subs.forEach((f) => f());
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
export const useSession = (): Session => useSyncExternalStore(subscribe, getSession);

export function sessionTask(s: Session): Task {
  return {
    input: s.task.trim(),
    selection: s.frag.trim() || undefined,
    history: s.turns.slice(-8),
    toggles: s.toggles,
    extraArtifactIds: s.extraArtifactIds,
  };
}
