import { atom } from "jotai";

export type SessionTimeFilter = "1h" | "6h" | "1d" | "3d" | "1w" | "1m" | "all";

export const sessionTimeFilterAtom = atom<SessionTimeFilter>("1d");

// Backward compatibility - can be removed after migration
export const showOldSessionsAtom = atom(
  (get) => get(sessionTimeFilterAtom) === "all",
  (_get, set, newValue: boolean) => {
    set(sessionTimeFilterAtom, newValue ? "all" : "1d");
  },
);
